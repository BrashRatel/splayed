import { fileURLToPath } from "node:url";
export const fromFileUrl = (url: URL): string => fileURLToPath(url);
