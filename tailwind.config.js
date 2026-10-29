/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./overlay.html",
    "./toast.html",
    "./region.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "#121212", // Very dark grey, almost black
        surface: "#1E1E1E",
        primary: "#BB86FC",
        secondary: "#03DAC6",
      }
    },
  },
  plugins: [],
}
