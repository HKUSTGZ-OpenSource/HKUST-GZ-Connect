use ec_compat::gateway_connector::GatewayConnectorGeneration;
use ec_compat::gateway_locator::resolve_gateway_locator;
use ec_compat::gateway_probe::{PublicGatewayProbeResult, probe_public_gateway_with_trust};
use ec_compat::gateway_tls::GatewayTlsTrust;
use std::time::Duration;

fn origin_argument(arguments: &[String]) -> Option<(&str, Option<&str>)> {
    if !matches!(arguments.len(), 2 | 4) || arguments[0] != "--origin" {
        return None;
    }
    if arguments.len() == 4 {
        if arguments[2] != "--leaf-sha256" {
            return None;
        }
        return Some((&arguments[1], Some(&arguments[3])));
    }
    Some((&arguments[1], None))
}

fn probe(entry: &str, pin: Option<&str>) -> ec_compat::Result<PublicGatewayProbeResult> {
    let origin = resolve_gateway_locator(entry, Duration::from_secs(3))?;
    let connector =
        GatewayConnectorGeneration::resolve_system("custom-probe", 1, 1, &origin, false)?;
    let trust = pin
        .map(|pin| GatewayTlsTrust::new(&origin, pin))
        .transpose()?;
    probe_public_gateway_with_trust(&connector, Duration::from_secs(8), trust.as_ref())
}

fn main() {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    let Some((origin, pin)) = origin_argument(&arguments) else {
        eprintln!("ec-gateway-probe: expected one Gateway origin");
        std::process::exit(64);
    };
    match probe(origin, pin) {
        Ok(result) => match serde_json::to_string(&result) {
            Ok(json) => println!("{json}"),
            Err(_) => {
                eprintln!("ec-gateway-probe: result could not be encoded");
                std::process::exit(1);
            }
        },
        Err(_) => {
            eprintln!("ec-gateway-probe: compatibility check failed");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn argument_contract_is_exact_and_does_not_accept_extra_request_material() {
        let valid = vec!["--origin".into(), "https://gateway.example.test".into()];
        assert_eq!(
            origin_argument(&valid),
            Some(("https://gateway.example.test", None))
        );
        for invalid in [
            vec![],
            vec!["--origin".into()],
            vec!["--path".into(), "/private".into()],
            vec![
                "--origin".into(),
                "https://gateway.example.test".into(),
                "secret".into(),
            ],
        ] {
            assert_eq!(origin_argument(&invalid), None);
        }
    }
}
