package main

import _ "embed"

//go:embed assets/cloudflared-windows-amd64.exe
var embeddedCloudflared []byte

const embeddedCloudflaredExeSuffix = ".exe"
