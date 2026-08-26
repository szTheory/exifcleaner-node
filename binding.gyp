{
  "targets": [
    {
      "target_name": "publication",
      "sources": ["native/publication.c"],
      "defines": ["NAPI_VERSION=8"],
      "conditions": [
        ["OS=='win'", {
          "msvs_settings": {
            "VCCLCompilerTool": {
              "RuntimeLibrary": 0
            }
          }
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
