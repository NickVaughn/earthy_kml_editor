/** A path's last component. Splits on both separators: Windows paths use '\'. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
