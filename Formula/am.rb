class Am < Formula
  desc "chezmoi for AI agent configs — define once in TOML, sync via git, generate native configs for every tool"
  homepage "https://github.com/Codeseys-Labs/agent-manager"
  version "0.5.0-rc6"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/Codeseys-Labs/agent-manager/releases/download/v#{version}/am-darwin-arm64"
      sha256 "07d545194a53f3f93348dbd9dc1e9abc0ea97b2f1026fab6f327ee5f80bf9ddd"
    end
    on_intel do
      url "https://github.com/Codeseys-Labs/agent-manager/releases/download/v#{version}/am-darwin-x64"
      sha256 "a8e2ff751840bd590c9d239d3f31787143210da85f313337ee15040abcf0184a"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/Codeseys-Labs/agent-manager/releases/download/v#{version}/am-linux-arm64"
      sha256 "a0bb1e03b3801898e01a6dd8cc34affdcfd830933c9dfa83b53702b4ff280416"
    end
    on_intel do
      url "https://github.com/Codeseys-Labs/agent-manager/releases/download/v#{version}/am-linux-x64"
      sha256 "8917787506c35d9025ebc500b9c311f688ba9bbf581bc913872e4bd2e709bd10"
    end
  end

  def install
    binary_name = stable.url.split("/").last
    bin.install binary_name => "am"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/am version")
  end

  def caveats
    <<~EOS
      To get started:
        am init

      Then sync your config:
        am apply
    EOS
  end
end
