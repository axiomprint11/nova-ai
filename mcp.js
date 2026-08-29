// ===== AxiomDB MCP endpoint (Streamable HTTP) =====
// Mount this BEFORE the SPA catch-all in server.js, or every request here
// gets swallowed and returns index.html.
//
//   const mountMcp = require('./mcp');
//   mountMcp(app, { runQuery, dataDictionary: DATA_DICTIONARY });
//
// Auth: set MCP_TOKEN in .env and connect Claude to
//   https://nova.axiomprint.com/mcp/<that-token>
// Leave MCP_TOKEN unset and /mcp is open to anyone who finds it.

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const SERVER_NAME = 'axiomdb';
const SERVER_VERSION = '1.0.0';
const MAX_ROWS = 200;

// ---- SQL guard: reads only, single statement ----
function assertReadOnly(sql) {
  const s = String(sql || '').trim().replace(/;\s*$/, '');
  if (!s) throw new Error('Empty query.');
  if (s.includes(';')) throw new Error('Multiple statements are not allowed. Send one query.');
  if (!/^(select|with|show|describe|desc|explain)\b/i.test(s)) {
    throw new Error('Only read queries are allowed (SELECT, WITH, SHOW, DESCRIBE, EXPLAIN).');
  }
  const banned = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|replace|rename|handler|load_file)\b|into\s+(outfile|dumpfile)/i;
  if (banned.test(s)) throw new Error('Write and DDL keywords are not permitted.');
  return s;
}

function jsonrpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function jsonrpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
function textResult(id, text, isError) {
  return jsonrpcResult(id, {
    content: [{ type: 'text', text: String(text) }],
    isError: !!isError
  });
}

function buildTools() {
  return [
    {
      name: 'query_database',
      description:
        'Run a read-only SQL query against the AxiomPrint MySQL database (schema axiomprint_new). ' +
        'SELECT / WITH / SHOW / DESCRIBE only, one statement per call. Returns up to ' + MAX_ROWS +
        ' rows as JSON. Use describe_schema first if you need table and column names.',
      inputSchema: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'The read-only SQL statement to execute.' },
          description: { type: 'string', description: 'Short note on what this query checks.' }
        },
        required: ['sql']
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    {
      name: 'describe_schema',
      description:
        'Return the AxiomPrint database guide: core tables, key columns, join patterns, and the ' +
        'known data quirks (stale production_status, quantity living in estimateoption, etc). ' +
        'Call this before writing a non-trivial query.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    {
      name: 'get_job',
      description:
        'Look up one job by its E-number (e.g. "E1173681" or just 1173681). Returns the estimate row, ' +
        'the client, the decoded option specs, and the latest production scan.',
      inputSchema: {
        type: 'object',
        properties: {
          job_number: { type: 'string', description: 'Job number, with or without the E prefix.' }
        },
        required: ['job_number']
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    }
  ];
}

module.exports = function mountMcp(app, opts) {
  const runQuery = opts.runQuery;
  const dataDictionary = opts.dataDictionary || 'No schema guide supplied.';
  const TOKEN = process.env.MCP_TOKEN || '';

  async function callTool(name, args) {
    args = args || {};

    if (name === 'describe_schema') {
      return dataDictionary;
    }

    if (name === 'query_database') {
      const sql = assertReadOnly(args.sql);
      const rows = await runQuery(sql);
      const shown = rows.slice(0, MAX_ROWS);
      let out = JSON.stringify(shown, null, 1);
      if (rows.length > MAX_ROWS) {
        out += '\n\n(showing ' + MAX_ROWS + ' of ' + rows.length + ' rows)';
      }
      return out;
    }

    if (name === 'get_job') {
      const estId = parseInt(String(args.job_number || '').replace(/[^0-9]/g, ''));
      if (!estId) throw new Error('Could not read a job number from "' + args.job_number + '".');

      const est = await runQuery(
        "SELECT e.id, COALESCE(NULLIF(e.estimate_printordernumber,''), CONCAT('E', e.id)) AS e_number, " +
        "COALESCE(NULLIF(e.estimate_name,''), p.title) AS label, p.title AS product_title, " +
        "e.estimate_price, e.new_total, e.estimate_type, e.created, " +
        "CONCAT(c.name,' ',c.last_name) AS client_name, c.company_name, c.email AS client_email, c.phone " +
        "FROM estimate e " +
        "LEFT JOIN product p ON p.id = e.estimate_productid " +
        "LEFT JOIN customer c ON c.id = e.estimate_clientid " +
        "WHERE e.id = " + estId + " LIMIT 1"
      );
      if (!est.length) return 'Job E' + estId + ' not found.';

      const specs = await runQuery(
        "SELECT estimate_option_name AS field, " +
        "COALESCE(NULLIF(selected,''), estimate_option_value) AS value " +
        "FROM estimateoption WHERE estimate_id = " + estId + " AND hidden = 0 ORDER BY `order` ASC"
      );

      let production = null;
      try {
        const ps = await runQuery(
          'SELECT production_step, created_at FROM qr_scan_history WHERE estimate_id = ' + estId +
          ' ORDER BY created_at DESC LIMIT 1'
        );
        if (ps.length) production = ps[0];
      } catch (e) { /* table may be absent on a partial restore */ }

      return JSON.stringify({
        job: est[0],
        specs: specs.filter(s => s.value != null && String(s.value).trim() !== ''),
        latest_production_scan: production,
        note: 'Production status comes from qr_scan_history. Ignore estimate.production_status; it is stale.'
      }, null, 1);
    }

    throw new Error('Unknown tool: ' + name);
  }

  async function handleMessage(msg) {
    const id = msg.id;
    const method = msg.method;

    // Notifications carry no id and expect no reply.
    if (id === undefined || id === null) return null;

    if (method === 'initialize') {
      const asked = (msg.params && msg.params.protocolVersion) || '';
      const version = PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
      return jsonrpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
      });
    }

    if (method === 'ping') return jsonrpcResult(id, {});

    if (method === 'tools/list') return jsonrpcResult(id, { tools: buildTools() });

    if (method === 'tools/call') {
      const name = msg.params && msg.params.name;
      const args = (msg.params && msg.params.arguments) || {};
      try {
        const text = await callTool(name, args);
        return textResult(id, text, false);
      } catch (err) {
        // Tool failures are results, not protocol errors — the model can react to them.
        return textResult(id, 'Error: ' + err.message, true);
      }
    }

    if (method === 'resources/list') return jsonrpcResult(id, { resources: [] });
    if (method === 'prompts/list') return jsonrpcResult(id, { prompts: [] });

    return jsonrpcError(id, -32601, 'Method not found: ' + method);
  }

  function checkToken(req, res) {
    if (!TOKEN) return true;
    if (req.params.token === TOKEN) return true;
    const authz = req.headers.authorization || '';
    if (authz === 'Bearer ' + TOKEN) return true;
    res.status(404).json({ error: 'Not found' });
    return false;
  }

  const paths = ['/mcp', '/mcp/:token'];

  app.post(paths, async (req, res) => {
    if (!checkToken(req, res)) return;
    try {
      const body = req.body;

      if (Array.isArray(body)) {
        const replies = [];
        for (const m of body) {
          const r = await handleMessage(m);
          if (r) replies.push(r);
        }
        if (!replies.length) return res.status(202).end();
        return res.json(replies);
      }

      const reply = await handleMessage(body || {});
      if (!reply) return res.status(202).end();
      return res.json(reply);
    } catch (err) {
      console.error('MCP error:', err.message);
      return res.status(500).json(jsonrpcError((req.body && req.body.id) || null, -32603, err.message));
    }
  });

  // No server-initiated streaming, so GET has nothing to open.
  app.get(paths, (req, res) => {
    if (!checkToken(req, res)) return;
    res.status(405).json(jsonrpcError(null, -32000, 'This server does not support SSE streams. Use POST.'));
  });

  // Stateless — nothing to tear down, but answer politely.
  app.delete(paths, (req, res) => {
    if (!checkToken(req, res)) return;
    res.status(200).end();
  });

  // Critical: a 404 here tells Claude the server is authless. The SPA catch-all
  // would otherwise return index.html, which Claude reads as a broken auth server.
  app.all(/^\/\.well-known\/oauth.*/, (req, res) => {
    res.status(404).json({ error: 'No authorization server. This MCP endpoint is authless.' });
  });

  console.log('MCP endpoint mounted at /mcp' + (TOKEN ? ' (token required)' : ' (NO TOKEN — open to the internet)'));
};
