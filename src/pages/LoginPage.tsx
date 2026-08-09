import { useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import {
  Alert,
  Button,
  Card,
  Center,
  PasswordInput,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { api } from "../api/client";
import { setAuthToken } from "../api/auth";
import { product } from "../lib/product";
import { RETURN_TO_PARAM, sanitizeReturnTo } from "../lib/returnTo";

// P2-T07 login screen — unsketched; feature-spec.md:95 "derive from spec +
// existing visual language". Minimal proposal (approved shape from the task):
// centered Mantine card, email + password, inline error state. Spec:
// feature-spec.md:18 "On: login screen (email + password or SSO redirect) →
// POST /auth/token; token attached by the single API client". On success the
// token is stored for the ACTIVE target and navigation returns to the
// validated ?return_to= path (same-origin relative only — lib/returnTo.ts),
// so P2-SHARE deep links round-trip through a 401. The app still calls
// GET /me on boot regardless (invariant; App.tsx re-boots on the token
// change). This page never knows which auth mode the backend runs — it is
// simply where 401s land.
export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.login(email, password);
      setAuthToken(res.access_token);
      const returnTo = new URLSearchParams(location.search).get(RETURN_TO_PARAM);
      navigate(sanitizeReturnTo(returnTo), { replace: true });
    } catch (err) {
      // ApiError carries the backend message (401 invalid_credentials →
      // "Invalid email or password."); a network failure carries fetch's.
      setError(err instanceof Error ? err.message : "Sign-in failed.");
      setBusy(false);
    }
  };

  return (
    <Center h="100vh">
      <Card withBorder w={360} p="lg">
        <form onSubmit={submit}>
          <Stack gap="sm">
            <Stack gap={2}>
              <Title order={3}>{product.label}</Title>
              <Text size="sm" c="dimmed">
                Sign in to continue
              </Text>
            </Stack>
            <TextInput
              label="Email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.currentTarget.value)}
              required
              data-autofocus
            />
            <PasswordInput
              label="Password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
              required
            />
            {error && (
              <Alert color="red" title="Sign-in failed" p="xs">
                {error}
              </Alert>
            )}
            <Button type="submit" loading={busy} fullWidth>
              Sign in
            </Button>
          </Stack>
        </form>
      </Card>
    </Center>
  );
}
