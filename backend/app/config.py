from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- Database -----------------------------------------------------------
    database_url: str

    # --- Clerk --------------------------------------------------------------
    clerk_secret_key: str
    clerk_jwks_url: str | None = None
    clerk_api_base: str = "https://api.clerk.com/v1"

    # --- Liveblocks ---------------------------------------------------------
    liveblocks_secret_key: str | None = None

    # --- Trigger.dev --------------------------------------------------------
    triggerdev_url: str = "https://api.trigger.dev"
    triggerdev_key: str | None = None

    # --- Vercel Blob --------------------------------------------------------
    blob_read_write_token: str | None = None

    # --- Web ---------------------------------------------------------------
    # Comma-separated list of origins allowed to call this API from a browser.
    cors_origins: str = "http://localhost:3000"
    frontend_url: str = "http://localhost:3000"

    # --- Email --------------------------------------------------------------
    resend_api_key: str | None = None
    resend_from_email: str | None = None

    environment: str = "development"

    # --- AI provider ---------------------------------------------------------
    # Set exactly one. OpenRouter takes precedence if multiple keys are set;
    # see `app.ai.active_provider`.
    openrouter_api_key: str | None = None
    openrouter_model: str = "openai/gpt-4o-mini"
    openrouter_http_referer: str = "http://localhost:3000"
    openai_api_key: str | None = None
    openai_model: str = "gpt-4o"
    anthropic_api_key: str | None = None
    anthropic_model: str = "claude-sonnet-4-20250514"
    # --- Local development only --------------------------------------------
    # Bypasses Clerk with a fixed local identity so the app can be explored
    # without a Clerk account. Guarded in __post_init__.
    dev_auth: bool = False
    dev_auth_email: str = "dev@localhost"
    dev_auth_clerk_id: str = "user_dev_local"

    def model_post_init(self, __context: object) -> None:
        """Pydantic v2 hook name.

        The v1 spelling `__post_init__` is never called by pydantic v2, so
        writing it here would leave this guard silently inert, which is the
        worst possible failure for the one check standing between a dev bypass
        and production.
        """
        if self.dev_auth and self.is_production:
            # Refuse to boot rather than silently serving an unauthenticated
            # API. A dev bypass left switched on in production is an open door,
            # so this has to be immediate and loud rather than a log line.
            raise RuntimeError(
                "DEV_AUTH is enabled but ENVIRONMENT=production. Refusing to "
                "start: this would serve the API without real authentication. "
                "Unset DEV_AUTH before deploying."
            )

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def is_production(self) -> bool:
        return self.environment == "production"


@lru_cache
def get_settings() -> Settings:
    return Settings()