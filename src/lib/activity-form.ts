export function hasActivityDetail(initial: Record<string, unknown> | undefined, fields: string[]) {
  return fields.some((field) => {
    const value = initial?.[field];
    return value !== undefined && value !== null && value !== "" && value !== false;
  });
}
