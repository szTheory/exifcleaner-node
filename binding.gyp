{
  "targets": [
    {
      "target_name": "publication",
      "sources": ["native/publication.c"],
      "defines": ["NAPI_VERSION=8"],
      "conditions": [
        ["OS=='win'", {
          "win_delay_load_hook": "false",
          "msvs_settings": {
            "VCCLCompilerTool": {
              "RuntimeLibrary": 0,
              "BufferSecurityCheck": "false",
              "OmitDefaultLibName": "true",
              "AdditionalOptions": ["/Oi-"]
            },
            "VCLinkerTool": {
              "IgnoreAllDefaultLibraries": "true",
              "AdditionalDependencies": ["kernel32.lib", "advapi32.lib", "ucrt.lib"],
              "AdditionalOptions": ["/NOENTRY"]
            }
          }
        }],
        ["OS=='linux'", {
          "cflags": ["-fno-stack-protector"]
        }],
        ["OS=='mac'", {
          "xcode_settings": {
            "CLANG_C_LANGUAGE_STANDARD": "c11",
            "GCC_ENABLE_STACK_PROTECTOR": "NO",
            "OTHER_CFLAGS": ["-fno-stack-protector"]
          }
        }]
      ]
    }
  ]
}
