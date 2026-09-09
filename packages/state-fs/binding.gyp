{
  "targets": [{
    "target_name": "state_fs",
    "sources": ["state_fs.c"],
    "cflags": ["-Wall", "-Wextra", "-Werror"],
    "xcode_settings": {"OTHER_CFLAGS": ["-Wall", "-Wextra", "-Werror"]},
    "conditions": [["OS!='linux' and OS!='mac'", {"type": "none"}]]
  }]
}
