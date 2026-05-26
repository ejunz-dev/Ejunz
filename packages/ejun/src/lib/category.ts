/** Parse comma-separated category/tag labels from form input. */
export function parseCategory(value: string): string[] {
    return value.replace(/，/g, ',').split(',').map((e) => e.trim()).filter(Boolean);
}
