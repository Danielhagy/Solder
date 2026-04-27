"""
At-rest encryption for connection secrets (FullSpec.md § 12 Q1).

Single-user local v1: a per-host symmetric key at `~/.solder/key`, mode 0600,
created on first use. Plaintext secrets travel between the API and this
module; ciphertext lives in the `connections.ciphertext` column with the
nonce alongside in `connections.nonce`. Decryption only happens at request
time (e.g. when a node makes a real HTTP call against a connector).

Cipher: AES-256-GCM (AEAD) — gives confidentiality + integrity in one pass,
matches industry default, and is available without additional setup beyond
the `cryptography` package.

The key file is intentionally simple — a single 32-byte key, base64-encoded
on disk so it survives Windows-centric editors that might mangle binary.
When v1 grows beyond local single-user (multi-tenant deploy, KMS, HSM, …)
this module is the single seam to swap out; nothing else needs to know.

Naming history: this module was `credential_crypto` through Slice 2.
"""

from __future__ import annotations

import base64
import json
import os
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

# 32 bytes ⇒ AES-256. AES-128 (16) would also be fine; we err on the safe
# side because the key never leaves the host.
_KEY_BYTES = 32
# 96-bit nonce is the recommendation for AES-GCM; do not change without
# reading the GCM IV-reuse risk literature first.
_NONCE_BYTES = 12

_KEY_PATH = Path.home() / ".solder" / "key"


class CryptoError(RuntimeError):
    """Raised on key-file or AEAD-tag failures."""


def _load_or_create_key() -> bytes:
    """Return the per-host AES key, creating it on first use.

    The key file is created with `O_CREAT | O_EXCL` and mode 0600 to avoid a
    TOCTOU window where a second process or a different user might pre-create
    a world-readable file in the same path.
    """
    if _KEY_PATH.is_file():
        try:
            blob = _KEY_PATH.read_text(encoding="utf-8").strip()
            key = base64.b64decode(blob)
        except Exception as e:  # pragma: no cover — disk corruption / mangled file
            raise CryptoError(f"key file at {_KEY_PATH} is unreadable: {e}") from e
        if len(key) != _KEY_BYTES:
            raise CryptoError(
                f"key file at {_KEY_PATH} has wrong length {len(key)} (expected {_KEY_BYTES})"
            )
        return key

    _KEY_PATH.parent.mkdir(parents=True, exist_ok=True)
    new_key = AESGCM.generate_key(bit_length=_KEY_BYTES * 8)
    encoded = base64.b64encode(new_key).decode("ascii")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    # 0o600 — owner read/write only. Windows largely ignores POSIX modes;
    # the OS-level ACL on the user-profile directory carries the protection
    # there, which is fine for v1 single-user-local.
    fd = os.open(str(_KEY_PATH), flags, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(encoded)
    except Exception:  # pragma: no cover
        # If the write failed, drop the half-written file so the next call
        # rolls a fresh key rather than raising "wrong length" forever.
        try:
            _KEY_PATH.unlink()
        except FileNotFoundError:
            pass
        raise
    return new_key


def encrypt(secret: dict[str, Any]) -> tuple[bytes, bytes]:
    """Serialize `secret` to canonical JSON and encrypt with AES-GCM.

    Returns `(ciphertext, nonce)`. Both go into the `connections` row; the
    GCM authentication tag is appended to `ciphertext` by the library, so
    callers don't deal with it explicitly.
    """
    key = _load_or_create_key()
    aead = AESGCM(key)
    nonce = os.urandom(_NONCE_BYTES)
    plaintext = json.dumps(secret, sort_keys=True, separators=(",", ":")).encode(
        "utf-8"
    )
    ciphertext = aead.encrypt(nonce, plaintext, associated_data=None)
    return ciphertext, nonce


def decrypt(ciphertext: bytes, nonce: bytes) -> dict[str, Any]:
    """Inverse of `encrypt`. Raises `CryptoError` on AEAD-tag mismatch."""
    key = _load_or_create_key()
    aead = AESGCM(key)
    try:
        plaintext = aead.decrypt(nonce, ciphertext, associated_data=None)
    except Exception as e:
        raise CryptoError(f"connection decryption failed: {e}") from e
    decoded = json.loads(plaintext.decode("utf-8"))
    if not isinstance(decoded, dict):
        raise CryptoError("decrypted payload is not a JSON object")
    return decoded


def reset_key_for_tests() -> None:
    """Drop the on-disk key. Test-only — production callers must not call.

    Useful for round-trip tests that want a deterministic from-zero state.
    """
    if _KEY_PATH.is_file():
        _KEY_PATH.unlink()
