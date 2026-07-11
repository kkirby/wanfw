// ajv's CJS type exports don't line up cleanly with NodeNext + esModuleInterop;
// import via createRequire to get the real constructor at runtime with a
// hand-written type for what we actually use.
import { createRequire } from "node:module";
import type { ValidateFunction } from "ajv";
import { CORE_SCHEMAS } from "./schemas.js";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js") as new (opts: {
  allErrors?: boolean;
  strict?: boolean;
}) => AjvInstance;
const addFormats = require("ajv-formats") as (ajv: AjvInstance) => void;

export interface AjvInstance {
  opts: { strict?: boolean };
  compile<T = unknown>(schema: object): ValidateFunction<T>;
}

export function createAjv(): AjvInstance {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv;
}

export function compileCoreValidators() {
  const ajv = createAjv();
  return {
    envelope: ajv.compile(CORE_SCHEMAS.envelope),
    framework: ajv.compile(CORE_SCHEMAS.framework),
    service: ajv.compile(CORE_SCHEMAS.service),
    pluginConfig: ajv.compile(CORE_SCHEMAS.pluginConfig),
  };
}
