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
/**
 * Parse an `ipma` box's payload (the bytes immediately after the FullBox version/flags, which the
 * caller has already stripped). `version`/`flags` come from that same FullBox header. Declines
 * `unsupported-box-version` for anything outside `{0, 1}`, and `box-framing` for a truncated
 * payload or an `association_count` running past the payload end.
 */
export declare function parseIpma(payload: Buffer, version: number, flags: number): readonly IpmaEntry[];
//# sourceMappingURL=ipma.d.ts.map