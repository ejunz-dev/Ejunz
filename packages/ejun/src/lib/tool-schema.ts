import Schema from 'schemastery';

export function schemaDescription(schema?: Schema): string | undefined {
    const value = schema?.meta?.description;
    if (!value) return undefined;
    if (typeof value === 'string') return value;
    if (typeof value[''] === 'string') return value[''];
    return Object.values(value).find((item): item is string => typeof item === 'string');
}

export function isSchema(value: unknown): value is Schema {
    return typeof value === 'function'
        && value !== null
        && typeof (value as Schema).uid === 'number'
        && typeof (value as Schema).type === 'string'
        && Boolean((value as Schema).meta);
}

function describe(json: Record<string, unknown>, schema: Schema, root: boolean): Record<string, unknown> {
    if (root) return json;
    const description = schemaDescription(schema);
    if (description) json.description = description;
    return json;
}

export function schemaToJsonSchema(schema: Schema, root = true): Record<string, any> {
    switch (schema.type) {
        case 'string': {
            const json: Record<string, any> = { type: 'string' };
            if (schema.meta?.pattern?.source) json.pattern = schema.meta.pattern.source;
            if (schema.meta?.min != null) json.minLength = schema.meta.min;
            if (schema.meta?.max != null) json.maxLength = schema.meta.max;
            return describe(json, schema, root);
        }
        case 'number': {
            const json: Record<string, any> = { type: schema.meta?.step === 1 ? 'integer' : 'number' };
            if (schema.meta?.min != null) json.minimum = schema.meta.min;
            if (schema.meta?.max != null) json.maximum = schema.meta.max;
            return describe(json, schema, root);
        }
        case 'boolean':
            return describe({ type: 'boolean' }, schema, root);
        case 'any':
            return describe({ type: 'object' }, schema, root);
        case 'const':
            return describe({ const: schema.value }, schema, root);
        case 'object': {
            const properties: Record<string, any> = {};
            const required: string[] = [];
            for (const [key, inner] of Object.entries(schema.dict || {})) {
                properties[key] = schemaToJsonSchema(inner, false);
                if (inner.meta?.required) required.push(key);
            }
            const json: Record<string, any> = { type: 'object', properties, additionalProperties: false };
            if (required.length) json.required = required;
            return describe(json, schema, root);
        }
        case 'array': {
            const json: Record<string, any> = {
                type: 'array',
                items: schema.inner ? schemaToJsonSchema(schema.inner, false) : {},
            };
            if (schema.meta?.min != null) json.minItems = schema.meta.min;
            if (schema.meta?.max != null) json.maxItems = schema.meta.max;
            return describe(json, schema, root);
        }
        case 'union': {
            const list = schema.list || [];
            if (list.length && list.every((item) => item.type === 'const')) {
                const values = list.map((item) => item.value);
                const json: Record<string, any> = { enum: values };
                const types = new Set(values.map((value) => typeof value));
                if (types.size === 1) {
                    const only = [...types][0];
                    if (only === 'string' || only === 'number' || only === 'boolean') json.type = only;
                }
                return describe(json, schema, root);
            }
            return describe({ anyOf: list.map((item) => schemaToJsonSchema(item, false)) }, schema, root);
        }
        case 'intersect':
            return describe({ allOf: (schema.list || []).map((item) => schemaToJsonSchema(item, false)) }, schema, root);
        case 'transform':
            return schema.inner ? schemaToJsonSchema(schema.inner, root) : {};
        case 'dict': {
            const json: Record<string, any> = {
                type: 'object',
                additionalProperties: schema.inner ? schemaToJsonSchema(schema.inner, false) : true,
            };
            return describe(json, schema, root);
        }
        default:
            return describe({ type: 'object' }, schema, root);
    }
}

export function validateToolArgs(schema: Schema, args: Record<string, unknown> | undefined): Record<string, unknown> {
    try {
        const value = schema(args ?? {});
        if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
        return {};
    } catch (error) {
        if (Schema.ValidationError.is(error)) throw new Error(error.message);
        throw error;
    }
}
