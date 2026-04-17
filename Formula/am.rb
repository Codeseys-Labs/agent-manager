class Am < Formula
  desc "chezmoi for AI agent configs — define once in TOML, sync via git, generate native configs for every tool"
  homepage "https://github.com/Codeseys-Labs/agent-manager"
  version "0.5.0-rc1"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/Codeseys-Labs/agent-manager/releases/download/v#{version}/am-darwin-arm64"
      sha256 "0a8d9d27c34e3b0ea1ed2984ed6ec67bbf5fc1c92a683ef3fb7eeba3803a4e37"
    end
    on_intel do
      url "https://github.com/Codeseys-Labs/agent-manager/releases/download/v#{version}/am-darwin-x64"
      sha256 "18109c90e2a6bf2ea21c70d2663ad41d8e296c1650cc0d19b7ee2877e3a0904a"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/Codeseys-Labs/agent-manager/releases/download/v#{version}/am-linux-arm64"
      sha256 "981f47338372f868fbe73e5eb7edc96ef51a26c3d69f54b220180ffb187bd2e7"
    end
    on_intel do
      url "https://github.com/Codeseys-Labs/agent-manager/releases/download/v#{version}/am-linux-x64"
      sha256 "dc0f2ff525f82551a9eb68cd85e81b03ab71a88c94afb87cbcf3dee7a6177b0b"
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
