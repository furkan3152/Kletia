/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        kletiaDark: '#0D0D0D', // Derin siyah (Arka plan)
        kletiaGray: '#212121', // Kullanıcı mesaj balonu
        kletiaBlue: '#0052FF', // Base ağı / Vurgu rengi
      }
    },
  },
  plugins: [],
}