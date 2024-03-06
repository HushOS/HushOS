type Config = {
    skU: number;
    pkU: number;
    pkS: number;
    idS: number;
    idU: number;
};

declare module 'libopaque' {
    const ready: Promise<void>;

    // utils
    function hexToUint8Array(hex: string): Uint8Array;
    function uint8ArrayToHex(uint8Array: Uint8Array): string;

    // server
    function createRegistrationResponse(params: { M: Uint8Array }): {
        sec: Uint8Array;
        pub: Uint8Array;
    };

    function storeUserRecord(params: { sec: Uint8Array; rec: Uint8Array }): { rec: Uint8Array };

    // client
    function createRegistrationRequest(params: { pwdU: string }): {
        M: Uint8Array;
        sec: Uint8Array;
    };

    function finalizeRequest(params: {
        sec: Uint8Array;
        pub: Uint8Array;
        cfg: Config;
        ids: { idS: string; idU: string };
    }): { rec: Uint8Array; export_key: Uint8Array };
}

// declare module 'libopaque/dist/libopaque.debug' {
//     export * from 'libopaque';
// }
