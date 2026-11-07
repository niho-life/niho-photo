import {defineConfig} from "vitest/config";
export default defineConfig({test:{environment:"jsdom",include:["test/photo-web-view.test.tsx","test/photo-web-transfer-panel.test.tsx","test/photo-web-shared-albums.test.ts"]},resolve:{dedupe:["react","react-dom","@tanstack/react-query","niho-ui"]}});
