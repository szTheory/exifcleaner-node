export interface IpmaLayout {
    readonly itemIdBytes: 2 | 4;
    readonly associationBytes: 1 | 2;
    readonly indexBits: 7 | 15;
}
export declare const IPMA_LAYOUTS: Readonly<Record<string, IpmaLayout>>;
export interface IpmaAssociation {
    readonly essential: boolean;
    readonly propertyIndex: number;
}
export interface IpmaEntry {
    readonly itemId: number;
    readonly associations: readonly IpmaAssociation[];
}
export declare function parseIpma(_payload: Buffer, _version: number, _flags: number): readonly IpmaEntry[];
//# sourceMappingURL=ipma.d.ts.map