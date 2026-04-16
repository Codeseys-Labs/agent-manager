class Am < Formula
  desc "chezmoi for AI agent configs — define once in TOML, sync via git, generate native configs for every tool"
  homepage "https://github.com/Codeseys-Labs/agent-manager"
  version "0.4.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/Codeseys-Labs/agent-manager/releases/download/v#{version}/am-darwin-arm64"
      sha256 "e78cb081f0a7f2e721c215d8e0421fa5e0e165ff9385942b8ee42110942d308f"
    end
    on_intel do
      url "https://github.com/Codeseys-Labs/agent-manager/releases/download/v#{version}/am-darwin-x64"
      sha256 "c9c71dbcdff5e6af7e21a290cff94b79923022f549c856dd37aa8ccf4fef543e"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/Codeseys-Labs/agent-manager/releases/download/v#{version}/am-linux-arm64"
      sha256 "e2df9320cd1bdb9c99b1dc778c5e428e2f1ef9687d9b78b9d4fd73c20aa8b1a4"
    end
    on_intel do
      url "https://github.com/Codeseys-Labs/agent-manager/releases/download/v#{version}/am-linux-x64"
      sha256 "159373e0024102e5a7dd34cbae6a195ec768acc9419a7a0b0e0291978c07374e"
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
