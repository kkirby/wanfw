import * as Ajv2020Module from "ajv/dist/2020.js";
import * as AjvFormatsModule from "ajv-formats";
import type { ValidateFunction } from "ajv";
import { CORE_SCHEMAS } from "./schemas.js";

// Static imports (not createRequire) so bundlers that do dependency tracing
// via static analysis -- notably Next.js's standalone output tracer, which
// tier1 relies on -- can see and include ajv in their output. ajv/ajv-formats
// ship CJS with a default export; the interop shape differs slightly between
// plain tsc/node and webpack, hence the defensive `.default ?? module` below.
type AjvCtorType = new (opts: { allErrors?: boolean; strict?: boolean }) => AjvInstance;
type AddFormatsType = (ajv: AjvInstance) => void;

const AjvCtor = ((Ajv2020Module as unknown as { default?: AjvCtorType }).default ??
  (Ajv2020Module as unknown as AjvCtorType)) as AjvCtorType;
const addFormats = ((AjvFormatsModule as unknown as { default?: AddFormatsType }).default ??
  (AjvFormatsModule as unknown as AddFormatsType)) as AddFormatsType;

export interface AjvInstance {
  opts: { strict?: boolean };
  compile<T = unknown>(schema: object): ValidateFunction<T>;
}

export function createAjv(): AjvInstance {
  const ajv = new AjvCtor({ allErrors: true, strict: true });
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
