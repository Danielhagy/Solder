/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        // Body text — neutral, ubiquitous.
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        // Engineering / metadata — JetBrains Mono.
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
        // Display headlines + wordmark — Space Grotesk gives Solder a wider,
        // slightly industrial voice that the wordmark can carry. Used sparingly
        // (wordmark, integration title, page hero) so it stays distinctive.
        display: ['"Space Grotesk"', 'Inter', 'system-ui', 'sans-serif']
      },
      boxShadow: {
        node: '0 1px 2px rgba(9, 9, 11, 0.04), 0 4px 12px rgba(9, 9, 11, 0.06)',
        'node-hover': '0 2px 4px rgba(9, 9, 11, 0.06), 0 10px 20px rgba(9, 9, 11, 0.08)',
        // Glass-rail elevation — the floating sidebar / props panel / topbar
        // sit on top of the dark workbench with this shadow set.
        rail: '0 1px 2px rgba(0, 0, 0, 0.06), 0 12px 32px rgba(0, 0, 0, 0.18)',
        'rail-dark':
          '0 1px 0 rgba(255, 255, 255, 0.04) inset, 0 16px 48px rgba(0, 0, 0, 0.55)',
        // Forge-glow — used for run-state and the active drop target. Sized so
        // it reads as "heat" without overpowering the card content.
        'forge-glow': '0 0 0 1px rgba(249, 115, 22, 0.45), 0 0 24px rgba(249, 115, 22, 0.25)'
      },
      colors: {
        primary: {
          50: '#f0f9ff',
          100: '#e0f2fe',
          200: '#bae6fd',
          300: '#7dd3fc',
          400: '#38bdf8',
          500: '#0ea5e9',
          600: '#0284c7',
          700: '#0369a1',
          800: '#075985',
          900: '#0c4a6e',
          950: '#082f49'
        },
        surface: {
          50: '#fafafa',
          100: '#f4f4f5',
          200: '#e4e4e7',
          300: '#d4d4d8',
          400: '#a1a1aa',
          500: '#71717a',
          600: '#52525b',
          700: '#3f3f46',
          800: '#27272a',
          900: '#18181b',
          950: '#09090b'
        },
        /*
         * Forge — the brand's hot palette. The ember field on the canvas is
         * the only place this hue used to live; promoting it to a token scale
         * lets us route MEANINGFUL affordances through it (run state, primary
         * CTA, selected node ring) so the rest of the app shares the canvas's
         * vocabulary instead of speaking only sky-blue. Calibrated against
         * Tailwind's `orange` scale so it composes cleanly with `amber` /
         * `red` chips already in use for warnings and errors.
         */
        forge: {
          50: '#fff7ed',
          100: '#ffedd5',
          200: '#fed7aa',
          300: '#fdba74',
          400: '#fb923c',
          500: '#f97316',
          600: '#ea580c',
          700: '#c2410c',
          800: '#9a3412',
          900: '#7c2d12',
          950: '#431407'
        }
      }
    }
  },
  plugins: []
};
