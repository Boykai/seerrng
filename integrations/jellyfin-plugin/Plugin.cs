using System;
using System.Collections.Generic;
using System.Globalization;
using Jellyfin.Plugin.SeerrNGBridge.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.SeerrNGBridge;

public sealed class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
  public static readonly Guid PluginId = Guid.Parse("812a21b1-2e18-4ff7-a9b8-3dd84e2a0e16");

  public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
      : base(applicationPaths, xmlSerializer)
  {
    Instance = this;
  }

  public static Plugin? Instance { get; private set; }

  public override string Name => "SeerrNG Bridge";

  public override Guid Id => PluginId;

  public IEnumerable<PluginPageInfo> GetPages()
  {
    var resourcePrefix = GetType().Namespace ?? "Jellyfin.Plugin.SeerrNGBridge";

    return
    [
        new PluginPageInfo
            {
                Name = "SeerrNGBridgeConfiguration",
                DisplayName = "SeerrNG Bridge Settings",
                EmbeddedResourcePath = string.Format(
                    CultureInfo.InvariantCulture,
                    "{0}.Configuration.configPage.html",
                    resourcePrefix),
            },
            new PluginPageInfo
            {
                Name = "SeerrNGBridge",
                DisplayName = "SeerrNG",
                EmbeddedResourcePath = string.Format(
                    CultureInfo.InvariantCulture,
                    "{0}.Configuration.mainPage.html",
                    resourcePrefix),
                EnableInMainMenu = true,
                MenuIcon = "link",
            },
        ];
  }
}
