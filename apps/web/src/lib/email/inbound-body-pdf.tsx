/**
 * Render an HTML-only (or text-only) invoice EMAIL to a PDF, so it goes through the
 * same AI bill read, the same document store and the same reviewer side-by-side view
 * as an attached PDF. Uses @react-pdf/renderer (already used for statements) — no
 * headless browser. Layout fidelity is text-level (tables become tab-separated
 * lines), which is what the extraction needs; the original HTML is kept in the .eml.
 */

import React from 'react';
import { Document, Page, Text, View, StyleSheet, renderToBuffer } from '@react-pdf/renderer';
import type { InboundEmail } from './inbound-types';
import { bodyTextForRender } from './inbound-eml';

const styles = StyleSheet.create({
  page: { padding: 40, fontSize: 10, fontFamily: 'Helvetica', color: '#0A1628' },
  head: { borderBottomWidth: 1, borderBottomColor: '#2563EB', paddingBottom: 8, marginBottom: 12 },
  label: { fontSize: 8, color: '#3D4F65', textTransform: 'uppercase', letterSpacing: 1 },
  meta: { fontSize: 10, marginBottom: 2 },
  line: { fontSize: 10, lineHeight: 1.4 },
  foot: { position: 'absolute', bottom: 24, left: 40, right: 40, fontSize: 7, color: '#8494A7' },
});

/** Cap the rendered body (a 2 MB newsletter is not an invoice). */
const MAX_CHARS = 60_000;

function EmailBodyPdf({ email }: { email: InboundEmail }) {
  const body = bodyTextForRender(email).slice(0, MAX_CHARS);
  const lines = body.split('\n');
  return (
    <Document title={email.subject ?? 'Email'} author={email.from.address}>
      <Page size="LETTER" style={styles.page} wrap>
        <View style={styles.head}>
          <Text style={styles.label}>Invoice received by email</Text>
          <Text style={styles.meta}>From: {email.from.name ? `${email.from.name} <${email.from.address}>` : email.from.address}</Text>
          <Text style={styles.meta}>Subject: {email.subject ?? '(no subject)'}</Text>
          <Text style={styles.meta}>Received: {new Date(email.receivedAt).toUTCString()}</Text>
        </View>
        {lines.map((l, i) => (
          <Text key={i} style={styles.line}>{l.replace(/\t/g, '    ') || ' '}</Text>
        ))}
        <Text style={styles.foot} fixed>
          Rendered by MeritBooks from the email body. The original email is kept alongside this document.
        </Text>
      </Page>
    </Document>
  );
}

/** PDF bytes for the email body; null when there is no body to render. */
export async function renderEmailBodyPdf(email: InboundEmail): Promise<Buffer | null> {
  if (!bodyTextForRender(email)) return null;
  return renderToBuffer(<EmailBodyPdf email={email} />);
}
