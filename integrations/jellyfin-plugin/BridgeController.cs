using Jellyfin.Plugin.SeerrNGBridge.Configuration;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.SeerrNGBridge;

[ApiController]
[Authorize]
[Route("Plugins/SeerrNGBridge")]
public sealed class BridgeController : ControllerBase
{
  [HttpGet("Configuration")]
  public ActionResult GetPublicConfiguration()
  {
    var configuration = Plugin.Instance?.Configuration;
    if (configuration is null)
    {
      return NotFound();
    }

    return Ok(new { seerrNgUrl = configuration.SeerrNgUrl });
  }
}
