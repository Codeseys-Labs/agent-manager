class Am < Formula
  desc "control plane for AI agents — catalog, MCP gateway, protocol router (ACP/A2A), marketplace"
  homepage "https://github.com/Codeseys-Labs/agent-manager"
  version "0.5.0-rc.8"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/Codeseys-Labs/agent-manager/releases/download/v#{version}/am-darwin-arm64"
      sha256 "0f3d5eaa740de95d11305af484ea6ef51ca54b732949f951776e06c22c7419f5"
      resource "am-acp-shell" do
        url "https://github.com/Codeseys-Labs/agent-manager/releases/download/v#{version}/am-acp-shell-darwin-arm64"
        sha256 "8d1f1d4e812c02abbe9ff40fc86c6d9db1659238d8c0ef27eaed8c017d5a9f0f"
      end
    end
    on_intel do
      url "https://github.com/Codeseys-Labs/agent-manager/releases/download/v#{version}/am-darwin-x64"
      sha256 "86728e24440413971ac2eb3297484dd6b4928f72d86ba2e49de5c1fc29f6101b"
      resource "am-acp-shell" do
        url "https://github.com/Codeseys-Labs/agent-manager/releases/download/v#{version}/am-acp-shell-darwin-x64"
        sha256 "0fc3537d9a725022efcf169edf34be9a7f5515c4356413d849a5947516cb0c33"
      end
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/Codeseys-Labs/agent-manager/releases/download/v#{version}/am-linux-arm64"
      sha256 "e7d7adb305222e8f308066f35044e14346d695d6409fb53eed1fcbfedf1a1051"
      resource "am-acp-shell" do
        url "https://github.com/Codeseys-Labs/agent-manager/releases/download/v#{version}/am-acp-shell-linux-arm64"
        sha256 "192eb6bf9d38d8b3c62c78cf274aa41b067cc8d6974ee499975ddec8464cab24"
      end
    end
    on_intel do
      url "https://github.com/Codeseys-Labs/agent-manager/releases/download/v#{version}/am-linux-x64"
      sha256 "78bf1f167cdabf55f388b0ea236c5efd280e2adf7684bd47b16d3dbfc3a0a2a9"
      resource "am-acp-shell" do
        url "https://github.com/Codeseys-Labs/agent-manager/releases/download/v#{version}/am-acp-shell-linux-x64"
        sha256 "28dd4bcdaac5128b135849c296bf80915f333222e311dcee5a070ccb77e45fd6"
      end
    end
  end

  def install
    # Primary binary: install the downloaded artifact as `am`.
    binary_name = stable.url.split("/").last
    bin.install binary_name => "am"
    # Tier-2 shim binary: fetch + install as `am-acp-shell`.
    resource("am-acp-shell").stage do
      shell_binary = Dir["am-acp-shell-*"].first
      bin.install shell_binary => "am-acp-shell"
    end
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/am version")
  end

  def caveats
    <<~EOS
      To get started (guided first-run wizard — detect tools, import
      existing configs, set up secrets + profile, apply, health check):
        am setup

      Or drive the steps manually:
        am init && am import auto && am apply

      To use a Tier-2 wrapped agent (aider / amazon-q / cody):
        am agent enable-shim <name> --yes
      Tier-2 wrappers inherit the underlying CLI's trust posture.
      See ADR-0033 for the security caveat.
    EOS
  end
end
