// tools/build_geo.js - one-time: turn the US Census state boundaries (npm "us-atlas")
// into states.js (GeoJSON keyed by state abbreviation). Run: node tools/build_geo.js
var fs = require('fs'), path = require('path');
var topojson = require('/home/claude/vendor/node_modules/topojson-client');
var topo = JSON.parse(fs.readFileSync('/home/claude/vendor/node_modules/us-atlas/states-10m.json', 'utf8'));
var FIPS = {'01':'AL','02':'AK','04':'AZ','05':'AR','06':'CA','08':'CO','09':'CT','10':'DE','11':'DC','12':'FL','13':'GA','15':'HI','16':'ID','17':'IL','18':'IN','19':'IA','20':'KS','21':'KY','22':'LA','23':'ME','24':'MD','25':'MA','26':'MI','27':'MN','28':'MS','29':'MO','30':'MT','31':'NE','32':'NV','33':'NH','34':'NJ','35':'NM','36':'NY','37':'NC','38':'ND','39':'OH','40':'OK','41':'OR','42':'PA','44':'RI','45':'SC','46':'SD','47':'TN','48':'TX','49':'UT','50':'VT','51':'VA','53':'WA','54':'WV','55':'WI','56':'WY','72':'PR'};
var fc = topojson.feature(topo, topo.objects.states);
function round(c) { return Array.isArray(c[0]) ? c.map(round) : [Math.round(c[0] * 100) / 100, Math.round(c[1] * 100) / 100]; }
var feats = fc.features.filter(function (f) { return FIPS[String(f.id).padStart(2, '0')]; }).map(function (f) {
  var id = String(f.id).padStart(2, '0');
  return { type: 'Feature', id: FIPS[id], properties: { abbr: FIPS[id], name: f.properties.name }, geometry: { type: f.geometry.type, coordinates: round(f.geometry.coordinates) } };
});
fs.writeFileSync(path.join(__dirname, '..', 'states.js'), 'var STATES = ' + JSON.stringify({ type: 'FeatureCollection', features: feats }) + ';\n');
console.log('features:', feats.length, feats.map(function (f) { return f.id; }).join(' '));
