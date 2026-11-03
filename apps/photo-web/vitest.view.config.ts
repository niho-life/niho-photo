import {defineConfig} from "vitest/config";
export default defineConfig({test:{environment:"jsdom",include:["test/photo-web-view.test.tsx","test/photo-web-transfer-panel.test.tsx"]},resolve:{dedupe:["react","react-dom","@tanstack/react-query","niho-ui"]}});
