/** @type {import("tailwindcss").Config} */
const config = {
  darkMode: "class",
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
    "../../packages/photo-editing/src/**/*.{js,ts,jsx,tsx}",
    "../../packages/ui/src/**/*.{js,ts,jsx,tsx}",
    "../../packages/ui/tailwind-theme.cjs",
  ],
  theme: {
    extend: require("../../packages/ui/tailwind-theme.cjs").extend,
  },
  plugins: [require("tailwindcss-animate")],
};

module.exports = config;
