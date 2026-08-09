export default {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        kletiaDark: '#0D0D0D', 
        kletiaGray: '#212121', 
        kletiaBlue: '#0052FF', 
      }
    },
  },
  plugins: [],
}