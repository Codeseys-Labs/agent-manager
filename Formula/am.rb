class Am < Formula
  desc "control plane for AI agents — catalog, MCP gateway, protocol router (ACP/A2A), marketplace"
  homepage "https://github.com/Codeseys-Labs/agent-manager"
  version "0.5.0-rc7"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/Codeseys-Labs/agent-manager/releases/download/v#{version}/am-darwin-arm64"
      sha256 "b388e2f7688f1ff6d9838b04a268313ce5ab2668e0921c6005702df37a9b5519"
      resource "am-acp-shell" do
        url "https://github.com/Codeseys-Labs/agent-manager/releases/download/v#{version}/am-acp-shell-darwin-arm64"
        sha256 "8d1f1d4e812c02abbe9ff40fc86c6d9db1659238d8c0ef27eaed8c017d5a9f0f"
      end
    end
    on_intel do
      url "https://github.com/Codeseys-Labs/agent-manager/releases/download/v#{version}/am-darwin-x64"
      sha256 "f1e7c9697079ef988e5570c4e0ef9c031ad98a4c16fe026fec97c26c526d7cbc"
      resource "am-acp-shell" do
        url "https://github.com/Codeseys-Labs/agent-manager/releases/download/v#{version}/am-acp-shell-darwin-x64"
        sha256 "0fc3537d9a725022efcf169edf34be9a7f5515c4356413d849a5947516cb0c33"
      end
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/Codeseys-Labs/agent-manager/releases/download/v#{version}/am-linux-arm64"
      sha256 "b8f302e996f3686e653e2557e8b3b131127773951bc3714e79c603dea51acdb8"
      resource "am-acp-shell" do
        url "https://github.com/Codeseys-Labs/agent-manager/releases/download/v#{version}/am-acp-shell-linux-arm64"
        sha256 "192eb6bf9d38d8b3c62c78cf274aa41b067cc8d6974ee499975ddec8464cab24"
      end
    end
    on_intel do
      url "https://github.com/Codeseys-Labs/agent-manager/releases/download/v#{version}/am-linux-x64"
      sha256 "78f951cbade223a651dcfb018111660644ad8e69a74ddc88ed025fac22ab8650"
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
