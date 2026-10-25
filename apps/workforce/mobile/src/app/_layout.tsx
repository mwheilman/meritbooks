/**
 * Root: Clerk (same instance as Merit Books and Merit Projects; the publishable key comes from
 * EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY, the session lives in the phone's secure store), then the app
 * state once signed in. Signed out → the sign-in screen.
 */
import { ClerkLoaded, ClerkProvider, useAuth } from '@clerk/expo';
import { tokenCache } from '@clerk/expo/token-cache';
import { useEffect } from 'react';
import { Redirect, Stack, router, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider, useApp } from '@/state/app';
import { stationOnly, stationRedirect } from '@/core/station';
import { color, font } from '@/ui/theme';

const publishableKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ?? '';

/**
 * A tablet in station mode stays on the station screen (security review M3): any other route —
 * a push tap, a deep link, a back gesture — is sent back to /kiosk. Blank until the saved lock
 * state has loaded, so a restart never flashes the full app.
 */
function StationGuard() {
  const { stationLocked, today, extras } = useApp();
  const segments = useSegments();
  const only = stationOnly(today, extras);
  const target = stationRedirect(stationLocked, only, segments[0]);
  useEffect(() => {
    if (target) router.replace(target);
  }, [target]);
  if (stationLocked === null || target) return <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: color.bg }} />;
  return null;
}

function Gate() {
  const { isSignedIn, isLoaded } = useAuth();
  const segments = useSegments();
  const onSignIn = segments[0] === 'sign-in';
  if (!isLoaded) return null;
  if (!isSignedIn && !onSignIn) return <Redirect href="/sign-in" />;
  if (isSignedIn && onSignIn) return <Redirect href="/" />;
  const stack = <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.bg } }} />;
  return isSignedIn ? <AppProvider>{stack}<StationGuard /></AppProvider> : stack;
}

export default function RootLayout() {
  if (!publishableKey) {
    return (
      <View style={{ flex: 1, padding: 24, justifyContent: 'center', backgroundColor: color.bg }}>
        <Text style={font.title}>Merit Workforce is not set up</Text>
        <Text style={font.regular}>EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY is missing. See apps/workforce/README.md.</Text>
      </View>
    );
  }
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <ClerkProvider publishableKey={publishableKey} tokenCache={tokenCache}>
        <ClerkLoaded>
          <Gate />
        </ClerkLoaded>
      </ClerkProvider>
    </SafeAreaProvider>
  );
}
