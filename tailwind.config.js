/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        bg:     '#070b18',
        panel:  '#0c1226',
        elev:   '#121b35',
        elev2:  '#1b2748',
        inset:  '#060a16',
        line:   '#1f2b4e',
        line2:  '#2e3f6a',
        tx:     '#eaf0ff',
        tx2:    '#9fb0d4',
        tx3:    '#5d6e96',
        link:   '#4fc3e8',
        crit:   '#ff5d6c',
        high:   '#ffab3d',
        med:    '#ffd84d',
        pos:    '#3fd0a3',
        neg:    '#ff5d6c',
      },
      fontFamily: {
        sans: ['IBM Plex Sans', 'system-ui', 'sans-serif'],
        mono: ['IBM Plex Mono', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
}
