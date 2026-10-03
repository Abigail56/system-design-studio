"""Guards on the configuration itself.

These exist because a local `api/.env` turns DEV_AUTH on so the app can run
without Clerk. That is exactly the kind of setting that leaks into other
contexts, and when it does, every auth test passes against one fake identity
instead of failing loudly.
"""

from __future__ import annotations

import pytest

from app.config import Settings


def test_dev_auth_is_off_during_tests():
    """If this fails, the suite is running with auth bypassed."""
    from app.config import get_settings

    settings = get_settings()
    assert settings.dev_auth is False, (
        "DEV_AUTH is on in the test environment. Tests would authenticate every "
        "caller as the same dev user, so role and identity assertions would be "
        "meaningless."
    )


def test_environment_is_not_production_during_tests():
    from app.config import get_settings

    assert get_settings().environment != "production"


def test_production_refuses_to_start_with_dev_auth_enabled():
    """The bypass must be impossible to deploy, not merely discouraged."""
    with pytest.raises(RuntimeError, match="Refusing to start"):
        Settings(
            database_url="postgresql+asyncpg://u:p@localhost:5432/x",
            clerk_secret_key="sk_test_x",
            environment="production",
            dev_auth=True,
        )


def test_production_starts_fine_without_dev_auth():
    settings = Settings(
        database_url="postgresql+asyncpg://u:p@localhost:5432/x",
        clerk_secret_key="sk_test_x",
        environment="production",
        dev_auth=False,
    )
    assert settings.is_production
    assert settings.dev_auth is False


def test_dev_auth_is_allowed_in_development():
    settings = Settings(
        database_url="postgresql+asyncpg://u:p@localhost:5432/x",
        clerk_secret_key="sk_test_x",
        environment="development",
        dev_auth=True,
    )
    assert settings.dev_auth is True


def test_dev_auth_is_off_by_default():
    settings = Settings(
        database_url="postgresql+asyncpg://u:p@localhost:5432/x",
        clerk_secret_key="sk_test_x",
    )
    assert settings.dev_auth is False


def test_cors_origins_are_parsed_and_trimmed():
    settings = Settings(
        database_url="postgresql+asyncpg://u:p@localhost:5432/x",
        clerk_secret_key="sk_test_x",
        cors_origins=" http://localhost:3000 , https://ghost.example , ",
    )
    assert settings.cors_origin_list == [
        "http://localhost:3000",
        "https://ghost.example",
    ]