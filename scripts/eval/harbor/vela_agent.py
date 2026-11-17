"""Harbor agent adapter: run the Vela CLI inside a Harbor environment.

Harbor has no built-in Vela agent, so `harbor run --agent <import path>` loads this
class instead. It installs `@glows777/vela` from npm on Node, then runs one headless
session per trial:

    vela --print --mode json --model <provider>/<id> "<instruction>"

Usage (from the repository root):

    export PYTHONPATH="$PWD/scripts/eval/harbor:$PYTHONPATH"
    export DEEPSEEK_API_KEY=...            # or put agents[].env in a job config
    harbor run -d <dataset> -a vela_agent:Vela -m deepseek/deepseek-v4-pro -e runta

Options (harbor `--ak name=value`): `thinking` maps to `--thinking`, `version` pins the
npm package version, `skip_install` uses a vela already in the image.

Logs: stdout and stderr are merged into `/logs/agent/vela.txt` in the trial's
`agent/` folder, and `VELA_DIR` points at `/logs/agent/vela`, so the session
transcript (`sessions/<id>/transcript.jsonl`) is collected with it.
"""

from __future__ import annotations

import shlex
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Annotated, override

from pydantic import Field

from harbor.agents.agent_auth_resolution import ModelConnectionSpec, ProviderAccess
from harbor.agents.capabilities import AgentCapabilities
from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.agents.options import Cli, InstalledAgentOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.model_api_format import ModelApiFormat

_PACKAGE = "@glows777/vela"
# Vela needs Node >= 22.18; the nvm snippet's default major 22 also works, but 24 is
# the version the CLI is developed and released against.
_NODE_MAJOR = 24
_REMOTE_VELA_DIR = PurePosixPath("/logs/agent/vela")
_OUTPUT_FILENAME = "vela.txt"


@dataclass(frozen=True)
class _ModelTarget:
    provider: str | None
    model_id: str

    @property
    def spec(self) -> str:
        return f"{self.provider}/{self.model_id}" if self.provider else self.model_id


class VelaOptions(InstalledAgentOptions):
    thinking: Annotated[str | None, Cli("--thinking")] = Field(
        default=None,
        description=(
            "Thinking level: off, minimal, low, medium, high, xhigh or max. "
            "Omit to use Vela's default."
        ),
    )


class Vela(BaseInstalledAgent):
    """Vela, installed from npm and run non-interactively with JSON events."""

    capabilities = AgentCapabilities()
    MODEL_CONNECTION = ModelConnectionSpec(
        supported_api_formats=[
            ModelApiFormat.OPENAI_CHAT_COMPLETIONS,
            ModelApiFormat.OPENAI_RESPONSES,
            ModelApiFormat.ANTHROPIC_MESSAGES,
        ],
        # Fallback for providers Harbor's table does not know; Vela's built-in
        # providers read DEEPSEEK_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY.
        agent_provider_access=ProviderAccess(
            api_key_candidate_names=["DEEPSEEK_API_KEY"],
            base_url_candidate_names=["DEEPSEEK_BASE_URL", "DEEPSEEK_API_BASE"],
        ),
    )
    options_model = VelaOptions
    options: VelaOptions

    @staticmethod
    @override
    def name() -> str:
        return "vela"

    @override
    def get_version_command(self) -> str | None:
        return ". ~/.nvm/nvm.sh; vela --version"

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await self.ensure_system_dependencies(environment, ("curl",))
        version_spec = f"@{self._version}" if self._version else "@latest"
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"{nvm_node_install_snippet(_NODE_MAJOR)} && "
                f"npm install -g --ignore-scripts {_PACKAGE}{version_spec} && "
                "vela --version"
            ),
        )

    def _model_target(self) -> _ModelTarget:
        if not self.model_name:
            raise ValueError("Model name must be in the format provider/model_name")
        provider, model_id = self._parse_model_name(self.model_name)
        access = self.model_connection
        return _ModelTarget(provider=access.provider or provider, model_id=model_id)

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        target = self._model_target()
        env = dict(self.model_connection.env)
        env["VELA_DIR"] = _REMOTE_VELA_DIR.as_posix()

        cli_flags = self.build_cli_flags()
        cli_flags_arg = f"{cli_flags} " if cli_flags else ""
        output_path = self.environment_logs_dir / _OUTPUT_FILENAME

        await self.exec_as_agent(
            environment,
            command=(
                "set -o pipefail; "
                ". ~/.nvm/nvm.sh; "
                f"mkdir -p {shlex.quote(_REMOTE_VELA_DIR.as_posix())} && "
                "vela --print --mode json "
                f"--model {shlex.quote(target.spec)} "
                f"{cli_flags_arg}"
                f"{shlex.quote(instruction)} "
                # Streaming deltas (message_update) repeat the whole partial message
                # for every token; message_end keeps the final content. Dropping them
                # turns a multi-hundred-MB log into a few MB.
                '2>&1 </dev/null | grep -v \'"type":"message_update"\' '
                f"| tee {shlex.quote(str(output_path))}"
            ),
            env=env,
        )
