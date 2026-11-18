export declare function fromBase64(s: string): Uint8Array
export declare function toBase64(bytes: Uint8Array): string
export declare function frameCells(indices: Uint8Array, size: number, palette: number[]): Uint32Array
export declare function rasterCells(indices: Uint8Array, size: number, palette: number[]): string
export declare function ansiLines(indices: Uint8Array, size: number, palette: number[]): string[]
