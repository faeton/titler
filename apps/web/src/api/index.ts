import { httpApi } from "./http";
import type { Api } from "./types";

export * from "./types";
export * from "./derive";

export const MOCK = import.meta.env.VITE_MOCK === "1";

let impl: Api = httpApi;
if (MOCK) impl = (await import("./mock")).mockApi;

export const api: Api = impl;
