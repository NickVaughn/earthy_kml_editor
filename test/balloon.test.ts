import { describe, it, expect } from 'vitest';
import { KmlDocument } from '@renderer/model/document';
import { parseKml } from '@renderer/model/parse';
import { resolveBalloonHtml } from '@renderer/model/balloon';
import { fixture } from './helpers';

describe('balloon resolution', () => {
  it('substitutes BalloonStyle $[schema/field] entities from SchemaData', () => {
    const doc = parseKml(fixture('hawaii_may26_campaign.kml'));
    const model = new KmlDocument(doc);
    const pm = model
      .placemarksUnder()
      .find((p) =>
        p.extendedData?.fields?.some((f) => f.value === 'GAO20260429t185525p0000_lidar'),
      );
    expect(pm).toBeTruthy();

    const html = resolveBalloonHtml(doc, pm!);
    // Entities resolved, none left dangling.
    expect(html).not.toContain('$[');
    expect(html).toContain('GAO20260429t185525p0000_lidar'); // NAME
    expect(html).toContain('coral_kawaihae'); // SITE
    expect(html).toContain('4-29-2026'); // DATE
  });

  it('parses SchemaData SimpleData into fields', () => {
    const doc = parseKml(fixture('hawaii_may26_campaign.kml'));
    const model = new KmlDocument(doc);
    const pm = model.placemarksUnder().find((p) => p.extendedData?.fields?.length);
    expect(pm!.extendedData!.fields!.length).toBe(15);
    const byName = new Map(pm!.extendedData!.fields!.map((f) => [f.name, f.value]));
    expect(byName.get('SITE')).toBe('coral_kawaihae');
  });

  it('falls back to a default table for Data without a description', () => {
    const kml = `<?xml version="1.0"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
  <Placemark><name>P</name>
    <ExtendedData>
      <Data name="population"><value>12345</value></Data>
      <Data name="region"><value>West</value></Data>
    </ExtendedData>
    <Point><coordinates>-95,39</coordinates></Point>
  </Placemark>
</Document></kml>`;
    const doc = parseKml(kml);
    const model = new KmlDocument(doc);
    const pm = model.placemarksUnder()[0];
    const html = resolveBalloonHtml(doc, pm);
    expect(html).toContain('population');
    expect(html).toContain('12345');
    expect(html).toContain('West');
  });

  it('escapes HTML in substituted values', () => {
    const kml = `<?xml version="1.0"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
  <Placemark><name>P</name>
    <ExtendedData><Data name="x"><value>&lt;script&gt;</value></Data></ExtendedData>
    <Point><coordinates>0,0</coordinates></Point>
  </Placemark>
</Document></kml>`;
    const doc = parseKml(kml);
    const model = new KmlDocument(doc);
    const html = resolveBalloonHtml(doc, model.placemarksUnder()[0]);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
