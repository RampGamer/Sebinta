package main

import _ "embed"

//go:embed assets/cloudflared-linux-amd64
var embeddedCloudflared []byte

const embeddedCloudflaredExeSuffix = ""
