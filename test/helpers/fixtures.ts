export const MINIMAL_CONFIG_TOML = `
[settings]
default_profile = "default"

[servers.fetch]
command = "uvx"
args = ["mcp-server-fetch"]
tags = ["utility"]

[profiles.default]
description = "Default profile"
servers = ["fetch"]
`;

export const CONFIG_WITH_PROFILES_TOML = `
[settings]
default_profile = "work"

[servers.fetch]
command = "uvx"
args = ["mcp-server-fetch"]
tags = ["utility"]

[servers.tavily]
command = "bunx"
args = ["tavily-mcp@latest"]
tags = ["search", "web"]

[servers.outlook]
command = "aws-outlook-mcp"
tags = ["email", "work"]

[profiles.base]
description = "Base utilities"
servers = ["fetch"]

[profiles.work]
description = "Work environment"
inherits = "base"
servers = ["tavily"]
server_tags = ["work"]
`;
