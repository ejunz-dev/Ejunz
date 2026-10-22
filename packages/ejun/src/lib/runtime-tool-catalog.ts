export interface RuntimeToolCapability {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}

const MAX_RUNTIME_TOOLS = 512;
const MAX_TOOL_NAME_LENGTH = 128;
const MAX_DESCRIPTION_LENGTH = 8192;
const MAX_SCHEMA_BYTES = 256 * 1024;
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate the Agent runtime's per-scope tool capabilities crossing the host API. */
export function parseRuntimeToolCapabilities(value: unknown): RuntimeToolCapability[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error('runtimeTools must be an array');
    if (value.length > MAX_RUNTIME_TOOLS) throw new Error(`runtimeTools must not exceed ${MAX_RUNTIME_TOOLS} entries`);

    const names = new Set<string>();
    let catalogBytes = 0;
    return value.map((entry, index) => {
        if (!isRecord(entry)) throw new Error(`runtimeTools[${index}] must be an object`);
        const { name, description, inputSchema } = entry;
        const hasControlCharacters = typeof name === 'string' && [...name].some((character) => {
            const code = character.charCodeAt(0);
            return code < 0x20 || code === 0x7f;
        });
        if (typeof name !== 'string' || !name.trim() || name.length > MAX_TOOL_NAME_LENGTH || hasControlCharacters) {
            throw new Error(`runtimeTools[${index}].name is invalid`);
        }
        if (names.has(name)) throw new Error(`runtime tool ${name} is duplicated`);
        names.add(name);
        if (typeof description !== 'string' || !description.trim() || description.length > MAX_DESCRIPTION_LENGTH) {
            throw new Error(`runtimeTools[${index}].description is invalid`);
        }
        if (!isRecord(inputSchema)) throw new Error(`runtimeTools[${index}].inputSchema must be an object`);

        let serialized: string | undefined;
        try {
            serialized = JSON.stringify(inputSchema);
        } catch {
            throw new Error(`runtimeTools[${index}].inputSchema is not JSON serializable`);
        }
        if (typeof serialized !== 'string') throw new Error(`runtimeTools[${index}].inputSchema is not JSON serializable`);
        const schemaBytes = Buffer.byteLength(serialized, 'utf8');
        if (schemaBytes > MAX_SCHEMA_BYTES) throw new Error(`runtimeTools[${index}].inputSchema exceeds ${MAX_SCHEMA_BYTES} bytes`);
        catalogBytes += Buffer.byteLength(name, 'utf8') + Buffer.byteLength(description, 'utf8') + schemaBytes;
        if (catalogBytes > MAX_CATALOG_BYTES) throw new Error(`runtimeTools exceeds ${MAX_CATALOG_BYTES} bytes`);

        return { name, description, inputSchema };
    });
}
