class Am < Formula
  desc "chezmoi for AI agent configs — define once in TOML, sync via git, generate native configs for every tool"
  homepage "https://github.com/Codeseys-Labs/agent-manager"
  version "0.5.0-rc4"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/Codeseys-Labs/agent-manager/releases/download/v#{version}/am-darwin-arm64"
      sha256 "50a19508b5bf253817c993381d1a878e787ecebe9e4a9cc2f9e03a57f7e45d85"
    end
    on_intel do
      url "https://github.com/Codeseys-Labs/agent-manager/releases/download/v#{version}/am-darwin-x64"
      sha256 "55cbe9dfdaccabf9da6eb845fd697aea3155fa266b7081506d9aafaea2c43fdb"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/Codeseys-Labs/agent-manager/releases/download/v#{version}/am-linux-arm64"
      sha256 "a718ea84f691bb9fb85b6cd839022e22e7b2a57a04411ae4181154b5da0c033e"
    end
    on_intel do
      url "https://github.com/Codeseys-Labs/agent-manager/releases/download/v#{version}/am-linux-x64"
      sha256 "b07c46a0b6530013b363db7fc6d28d29c7a741fa7c241f1c3f13006bb983c32f"
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
