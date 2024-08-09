import { createNodeMiddleware, createProbot } from "probot";
import app from "./lib/index.js";

export const probotApp = createNodeMiddleware(app, { probot: createProbot() });
