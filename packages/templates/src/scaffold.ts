/** Files `typst-pdf new` writes: a Tailwind invoice that shows the main features. */
export function scaffoldFiles(title: string, tailwind: boolean): Record<string, string> {
  const files: Record<string, string> = {
    "data.json": `${JSON.stringify(
      {
        numero: "F-0001",
        fecha: "2026-03-15",
        empresa: { nombre: "Mi Empresa SpA", rut: "76.000.000-0", direccion: "Av. Providencia 1234, Santiago" },
        cliente: { nombre: "Cliente Ejemplo Ltda.", rut: "77.111.222-3", email: "contacto@cliente.cl" },
        items: [
          { descripcion: "Diseño de plantilla", cantidad: 1, precio: 450000 },
          { descripcion: "Horas de soporte", cantidad: 12, precio: 35000 },
          { descripcion: "Licencia anual", cantidad: 1, precio: 120000 },
        ],
        notas: "Pago a 30 días.",
      },
      null,
      2,
    )}\n`,
    "template.json": `${JSON.stringify({ ...(tailwind ? { tailwind: true } : {}), page: { size: "A4", margin: "15mm 15mm 20mm", footer: '<div style="font-size: 8pt; color: #71717a; text-align: right">Página {{page}} de {{pages}}</div>' } }, null, 2)}\n`,
  };
  if (tailwind) {
    files["template.html"] = `{{!-- ${title}: Handlebars (variables, each, helpers) + Tailwind. --}}
<div class="text-[10pt] text-zinc-800">
  {{> encabezado}}

  <section class="mt-6 grid grid-cols-2 gap-6">
    <div>
      <p class="text-xs font-semibold uppercase tracking-wide text-zinc-500">Cliente</p>
      <p class="mt-1 font-semibold">{{cliente.nombre}}</p>
      <p>RUT {{cliente.rut}}</p>
      <p>{{default cliente.email "—"}}</p>
    </div>
    <div class="text-right">
      <p class="text-xs font-semibold uppercase tracking-wide text-zinc-500">Fecha</p>
      <p class="mt-1">{{date fecha "d 'de' MMMM 'de' yyyy"}}</p>
    </div>
  </section>

  <table class="mt-6 w-full border-collapse">
    <thead>
      <tr class="border-b-2 border-zinc-800 text-left">
        <th class="py-2">#</th>
        <th class="py-2">Descripción</th>
        <th class="py-2 text-right">Cantidad</th>
        <th class="py-2 text-right">Precio</th>
        <th class="py-2 text-right">Total</th>
      </tr>
    </thead>
    <tbody>
      {{#each items}}
      <tr class="border-b border-zinc-200">
        <td class="py-1.5 text-zinc-500">{{inc @index}}</td>
        <td class="py-1.5">{{descripcion}}</td>
        <td class="py-1.5 text-right">{{number cantidad}}</td>
        <td class="py-1.5 text-right">{{money precio}}</td>
        <td class="py-1.5 text-right">{{money (mul cantidad precio)}}</td>
      </tr>
      {{/each}}
    </tbody>
  </table>

  <div class="mt-4 flex justify-end">
    <div class="w-64 rounded-lg bg-zinc-100 p-4">
      <div class="flex justify-between"><span>Neto</span><span>{{money neto}}</span></div>
      <div class="flex justify-between"><span>IVA 19%</span><span>{{money (mul neto 0.19)}}</span></div>
      <div class="mt-2 flex justify-between border-t border-zinc-300 pt-2 font-bold"><span>Total</span><span>{{money (mul neto 1.19)}}</span></div>
    </div>
  </div>

  {{#if notas}}<p class="mt-6 text-zinc-500">{{notas}}</p>{{/if}}
</div>
`;
    files["style.css"] = `/* Tailwind is added automatically. Add your theme or custom CSS here. */
@theme {
  --color-marca: #4f46e5;
}
`;
    files["partials/encabezado.html"] = `<header class="flex items-start justify-between border-b border-zinc-200 pb-4">
  <div>
    <h1 class="text-2xl font-bold text-marca">{{empresa.nombre}}</h1>
    <p class="text-zinc-500">RUT {{empresa.rut}} · {{empresa.direccion}}</p>
  </div>
  <div class="rounded bg-marca px-3 py-1 font-semibold text-white">Factura {{numero}}</div>
</header>
`;
    // `neto` is computed in the data so the template stays simple.
    files["data.json"] = files["data.json"]!.replace('"notas"', '"neto": 990000,\n  "notas"');
  } else {
    files["template.html"] = `{{!-- ${title}: Handlebars (variables, each, helpers) + CSS. --}}
<h1>Factura {{numero}}</h1>
<p>{{empresa.nombre}} · {{date fecha "dd/MM/yyyy"}}</p>
<table>
  <thead><tr><th>Descripción</th><th>Cantidad</th><th>Total</th></tr></thead>
  <tbody>
    {{#each items}}<tr><td>{{descripcion}}</td><td>{{cantidad}}</td><td>{{money (mul cantidad precio)}}</td></tr>{{/each}}
  </tbody>
</table>
`;
    files["style.css"] = `body { font-family: sans-serif; font-size: 10pt }
table { width: 100%; border-collapse: collapse }
th, td { padding: 4px 6px; border-bottom: 1px solid #ddd; text-align: left }
`;
  }
  return files;
}
