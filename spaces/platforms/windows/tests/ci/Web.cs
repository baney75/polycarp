// drag.ps1's WebView2 window: a sizable form filled by a WebView2 control, titled "drag web". Its page is drawn by
// msedgewebview2.exe in child windows of another process, so a press lands on a window this process doesn't own.
// Built by drag.ps1 with Add-Type -OutputAssembly against the pinned Microsoft.Web.WebView2 package.
// Usage: web.exe <user data folder>
using System;
using System.Drawing;
using System.Windows.Forms;
using Microsoft.Web.WebView2.WinForms;

static class Web {
    [STAThread]
    static void Main(string[] args) {
        var f = new Form { Text = "drag web", StartPosition = FormStartPosition.Manual, Bounds = new Rectangle(250, 160, 520, 400) };
        var w = new WebView2 { Dock = DockStyle.Fill, CreationProperties = new CoreWebView2CreationProperties { UserDataFolder = args[0] } };
        f.Controls.Add(w);
        w.Source = new Uri("data:text/html,<body style='margin:0;background:%230559F1'></body>");
        Application.Run(f);
    }
}
