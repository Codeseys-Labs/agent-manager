class Am < Formula
  desc "chezmoi for AI agent configs — define once in TOML, sync via git, generate native configs for every tool"
  homepage "https://github.com/Codeseys-Labs/agent-manager"
  version "PLACEHOLDER_VERSION"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/Codeseys-Labs/agent-manager/releases/download/v#{version}/am-darwin-arm64"
      sha256 "PLACEHOLDER_SHA256_DARWIN_ARM64"
    end
    on_intel do
      url "https://github.com/Codeseys-Labs/agent-manager/releases/download/v#{version}/am-darwin-x64"
      sha256 "PLACEHOLDER_SHA256_DARWIN_X64"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/Codeseys-Labs/agent-manager/releases/download/v#{version}/am-linux-arm64"
      sha256 "PLACEHOLDER_SHA256_LINUX_ARM64"
    end
    on_intel do
      url "https://github.com/Codeseys-Labs/agent-manager/releases/download/v#{version}/am-linux-x64"
      sha256 "PLACEHOLDER_SHA256_LINUX_X64"
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
