import envelopeSchema from "./schemas/envelope.schema.json" with { type: "json" };
import frameworkSchema from "./schemas/framework.schema.json" with { type: "json" };
import serviceSchema from "./schemas/service.schema.json" with { type: "json" };
import pluginConfigSchema from "./schemas/plugin-config.schema.json" with { type: "json" };

export { envelopeSchema, frameworkSchema, serviceSchema, pluginConfigSchema };

export const CORE_SCHEMAS = {
  envelope: envelopeSchema,
  framework: frameworkSchema,
  service: serviceSchema,
  pluginConfig: pluginConfigSchema,
} as const;
