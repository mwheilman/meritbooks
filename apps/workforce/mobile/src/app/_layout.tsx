/**
 * Root: Clerk (same instance as Merit Books and Merit Projects; the publishable key comes from
 * EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY, the session lives in the phone's secure store), then the app
 * state once signed in. Signed out → the sign-in screen.
 */
import { ClerkLoaded, ClerkProvider, useAuth } from '@clerk/expo';
import { tokenCache } from '@clerk/expo/token-cache';
import { Redirect, Stack, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider } from '@/state/app';
import { color, font } from '@/ui/theme';

const publishableKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ?? '';

function Gate() {
  const { isSignedIn, isLoaded } = useAuth();
  const segments = useSegments();
  const onSignIn = segments[0] === 'sign-in';
  if (!isLoaded) return null;
  if (!isSignedIn && !onSignIn) return <Redirect href="/sign-in" />;
  if (isSignedIn && onSignIn) return <Redirect href="/" />;
  const stack = <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.bg } }} />;
  return isSignedIn ? <AppProvider>{stack}</AppProvider> : stack;
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
