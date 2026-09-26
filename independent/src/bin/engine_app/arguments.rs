//! Private ec-engine argument boundary. No environment, filesystem, credential
//! input or network access; the binary composition root owns those effects.
use ec_compat::engine::socks_auth::ProxyAuthenticationMode;
use ec_compat::{Error, Result};
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;

pub(super) struct EngineArguments {
    pub(super) config: PathBuf,
    pub(super) profile_binding_v1_stdin: bool,
    pub(super) bind: SocketAddr,
    pub(super) generation: u64,
    pub(super) proxy_authentication_mode: ProxyAuthenticationMode,
    pub(super) control_api_v2_stdin: bool,
    pub(super) source_interface: Option<String>,
    pub(super) source_address: Option<IpAddr>,
    #[cfg(feature = "engine-lifecycle-fixture")]
    pub(super) lifecycle_fixture: bool,
}

fn argument_value<'a>(args: &'a [String], name: &str) -> Result<&'a str> {
    args.iter()
        .position(|argument| argument == name)
        .and_then(|index| args.get(index + 1))
        .map(String::as_str)
        .ok_or_else(|| Error(format!("missing required argument: {name}")))
}

fn validate_arguments(args: &[String]) -> Result<()> {
    let mut config_seen = false;
    let mut profile_binding_seen = false;
    let mut credentials_seen = false;
    let mut socks_seen = false;
    let mut generation_seen = false;
    let mut socks_auth_seen = false;
    let mut control_api_seen = false;
    let mut source_interface_seen = false;
    let mut source_address_seen = false;
    #[cfg(feature = "engine-lifecycle-fixture")]
    let mut lifecycle_fixture_seen = false;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--credentials-stdin" if !credentials_seen => {
                credentials_seen = true;
                index += 1;
            }
            "--config" if !config_seen => {
                config_seen = true;
                require_argument_value(args, index, "--config")?;
                index += 2;
            }
            "--profile-binding-v1-stdin" if !profile_binding_seen => {
                profile_binding_seen = true;
                index += 1;
            }
            "--socks-bind" if !socks_seen => {
                socks_seen = true;
                require_argument_value(args, index, "--socks-bind")?;
                index += 2;
            }
            "--generation" if !generation_seen => {
                generation_seen = true;
                require_argument_value(args, index, "--generation")?;
                index += 2;
            }
            "--socks-auth-stdin" | "--socks-auth-optional-stdin" if !socks_auth_seen => {
                socks_auth_seen = true;
                index += 1;
            }
            "--control-api-v2-stdin" if !control_api_seen => {
                control_api_seen = true;
                index += 1;
            }
            "--source-interface" if !source_interface_seen => {
                source_interface_seen = true;
                require_argument_value(args, index, "--source-interface")?;
                index += 2;
            }
            "--source-address" if !source_address_seen => {
                source_address_seen = true;
                require_argument_value(args, index, "--source-address")?;
                index += 2;
            }
            #[cfg(feature = "engine-lifecycle-fixture")]
            "--test-lifecycle-transport" if !lifecycle_fixture_seen => {
                lifecycle_fixture_seen = true;
                index += 1;
            }
            _ => {
                // Never echo an unexpected value: a caller that mistakenly
                // supplied a credential flag must not have its value copied to
                // diagnostics.
                return Err(Error("unsupported or duplicate engine argument".into()));
            }
        }
    }
    Ok(())
}

fn require_argument_value(args: &[String], index: usize, name: &str) -> Result<()> {
    if args
        .get(index + 1)
        .is_none_or(|value| value.starts_with("--"))
    {
        return Err(Error(format!("{name} requires one value")));
    }
    Ok(())
}

pub(super) fn parse_arguments(args: &[String]) -> Result<EngineArguments> {
    validate_arguments(args)?;
    if !args
        .iter()
        .any(|argument| argument == "--credentials-stdin")
    {
        return Err(Error(
            "--credentials-stdin is required; credential flags do not exist".into(),
        ));
    }
    let config = PathBuf::from(argument_value(args, "--config")?);
    let profile_binding_v1_stdin = args
        .iter()
        .any(|argument| argument == "--profile-binding-v1-stdin");
    let bind = argument_value(args, "--socks-bind")?
        .parse::<SocketAddr>()
        .map_err(|_| Error("--socks-bind is not a valid socket address".into()))?;
    let generation = args
        .iter()
        .position(|argument| argument == "--generation")
        .map(|index| {
            args[index + 1]
                .parse::<u64>()
                .map_err(|_| Error("--generation must be an unsigned 64-bit integer".into()))
        })
        .transpose()?
        .unwrap_or(0);
    let proxy_authentication_mode = if args.iter().any(|argument| argument == "--socks-auth-stdin")
    {
        ProxyAuthenticationMode::Required
    } else if args
        .iter()
        .any(|argument| argument == "--socks-auth-optional-stdin")
    {
        ProxyAuthenticationMode::Optional
    } else {
        ProxyAuthenticationMode::None
    };
    let control_api_v2_stdin = args
        .iter()
        .any(|argument| argument == "--control-api-v2-stdin");
    let source_interface = args
        .iter()
        .position(|value| value == "--source-interface")
        .map(|index| args[index + 1].clone());
    let source_address = args
        .iter()
        .position(|value| value == "--source-address")
        .map(|index| {
            args[index + 1]
                .parse::<IpAddr>()
                .map_err(|_| Error("--source-address must be an IP address".into()))
        })
        .transpose()?;
    if source_interface.is_some() != source_address.is_some() {
        return Err(Error(
            "source interface and address must be selected together".into(),
        ));
    }
    #[cfg(feature = "engine-lifecycle-fixture")]
    let lifecycle_fixture = args
        .iter()
        .any(|argument| argument == "--test-lifecycle-transport");
    #[cfg(feature = "engine-lifecycle-fixture")]
    if lifecycle_fixture && (!control_api_v2_stdin || generation == 0) {
        return Err(Error(
            "lifecycle fixture requires Control v2 and a nonzero generation".into(),
        ));
    }
    Ok(EngineArguments {
        config,
        profile_binding_v1_stdin,
        bind,
        generation,
        proxy_authentication_mode,
        control_api_v2_stdin,
        source_interface,
        source_address,
        #[cfg(feature = "engine-lifecycle-fixture")]
        lifecycle_fixture,
    })
}

#[cfg(feature = "engine-lifecycle-fixture")]
pub(super) fn lifecycle_fixture_selected(arguments: &EngineArguments) -> bool {
    arguments.lifecycle_fixture
}

#[cfg(not(feature = "engine-lifecycle-fixture"))]
pub(super) fn lifecycle_fixture_selected(_arguments: &EngineArguments) -> bool {
    false
}

pub(super) fn generation_hint(args: &[String]) -> u64 {
    let matches = args
        .iter()
        .enumerate()
        .filter(|(_, argument)| argument.as_str() == "--generation")
        .collect::<Vec<_>>();
    if matches.len() != 1 {
        return 0;
    }
    args.get(matches[0].0 + 1)
        .and_then(|value| value.parse().ok())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_arguments() -> Vec<String> {
        [
            "--config",
            "profile.json",
            "--credentials-stdin",
            "--socks-bind",
            "127.0.0.1:1080",
        ]
        .map(str::to_owned)
        .to_vec()
    }

    #[test]
    fn engine_accepts_only_the_single_socks_listener_contract() {
        assert!(parse_arguments(&valid_arguments()).is_ok());

        let mut extra_listener = valid_arguments();
        extra_listener.extend(["--http-bind".into(), "127.0.0.1:1081".into()]);
        assert!(parse_arguments(&extra_listener).is_err());
    }

    #[test]
    fn engine_accepts_only_paired_bounded_underlay_arguments() {
        let mut arguments = valid_arguments();
        arguments.extend([
            "--source-interface".into(),
            "if:12".into(),
            "--source-address".into(),
            "192.0.2.20".into(),
        ]);
        let parsed = parse_arguments(&arguments).unwrap();
        assert_eq!(parsed.source_interface.as_deref(), Some("if:12"));
        assert_eq!(parsed.source_address, Some("192.0.2.20".parse().unwrap()));

        for suffix in [
            vec!["--source-interface".into(), "en0".into()],
            vec!["--source-address".into(), "192.0.2.20".into()],
            vec![
                "--source-interface".into(),
                "en0".into(),
                "--source-address".into(),
                "not-an-ip".into(),
            ],
        ] {
            let mut invalid = valid_arguments();
            invalid.extend(suffix);
            assert!(parse_arguments(&invalid).is_err());
        }
    }

    #[test]
    fn generation_is_optional_and_defaults_to_zero() {
        let parsed = parse_arguments(&valid_arguments()).unwrap();
        assert_eq!(parsed.generation, 0);
        assert!(!parsed.control_api_v2_stdin);
        assert_eq!(
            parsed.proxy_authentication_mode,
            ProxyAuthenticationMode::None
        );
    }

    #[test]
    fn control_v2_stdin_is_opt_in_and_duplicate_safe() {
        let mut arguments = valid_arguments();
        arguments.push("--control-api-v2-stdin".into());
        assert!(parse_arguments(&arguments).unwrap().control_api_v2_stdin);
        arguments.push("--control-api-v2-stdin".into());
        assert!(parse_arguments(&arguments).is_err());
    }

    #[cfg(not(feature = "engine-lifecycle-fixture"))]
    #[test]
    fn production_build_rejects_the_lifecycle_fixture_argument() {
        let mut arguments = valid_arguments();
        arguments.push("--test-lifecycle-transport".into());
        assert!(parse_arguments(&arguments).is_err());
    }

    #[cfg(feature = "engine-lifecycle-fixture")]
    #[test]
    fn lifecycle_fixture_requires_private_control_and_generation() {
        let mut arguments = valid_arguments();
        arguments.push("--test-lifecycle-transport".into());
        assert!(parse_arguments(&arguments).is_err());
        arguments.extend([
            "--control-api-v2-stdin".into(),
            "--generation".into(),
            "9".into(),
        ]);
        assert!(parse_arguments(&arguments).unwrap().lifecycle_fixture);
        arguments.push("--test-lifecycle-transport".into());
        assert!(parse_arguments(&arguments).is_err());
    }

    #[test]
    fn strict_local_proxy_authentication_is_an_optional_flag() {
        let mut arguments = valid_arguments();
        arguments.push("--socks-auth-stdin".into());
        assert_eq!(
            parse_arguments(&arguments)
                .unwrap()
                .proxy_authentication_mode,
            ProxyAuthenticationMode::Required
        );

        arguments.push("--socks-auth-stdin".into());
        assert!(parse_arguments(&arguments).is_err());
    }

    #[test]
    fn optional_local_proxy_authentication_is_mutually_exclusive_with_strict() {
        let mut optional = valid_arguments();
        optional.push("--socks-auth-optional-stdin".into());
        assert_eq!(
            parse_arguments(&optional)
                .unwrap()
                .proxy_authentication_mode,
            ProxyAuthenticationMode::Optional
        );

        optional.push("--socks-auth-stdin".into());
        assert!(parse_arguments(&optional).is_err());

        let mut strict_then_optional = valid_arguments();
        strict_then_optional.extend([
            "--socks-auth-stdin".into(),
            "--socks-auth-optional-stdin".into(),
        ]);
        assert!(parse_arguments(&strict_then_optional).is_err());
    }

    #[test]
    fn generation_accepts_the_full_unsigned_range() {
        let mut arguments = valid_arguments();
        arguments.extend(["--generation".into(), u64::MAX.to_string()]);
        let parsed = parse_arguments(&arguments).unwrap();
        assert_eq!(parsed.generation, u64::MAX);
        assert_eq!(generation_hint(&arguments), u64::MAX);
    }

    #[test]
    fn malformed_missing_and_duplicate_generations_are_rejected() {
        for suffix in [
            vec!["--generation".into()],
            vec!["--generation".into(), "-1".into()],
            vec!["--generation".into(), "not-a-number".into()],
            vec![
                "--generation".into(),
                "1".into(),
                "--generation".into(),
                "2".into(),
            ],
        ] {
            let mut arguments = valid_arguments();
            arguments.extend(suffix);
            assert!(parse_arguments(&arguments).is_err());
        }
    }

    #[test]
    fn unsupported_argument_diagnostic_does_not_echo_its_value() {
        let mut arguments = valid_arguments();
        arguments.extend(["--password".into(), "do-not-repeat-me".into()]);
        let error = match parse_arguments(&arguments) {
            Err(error) => error.to_string(),
            Ok(_) => panic!("credential flags must be rejected"),
        };
        assert!(!error.contains("password"));
        assert!(!error.contains("do-not-repeat-me"));
    }
}
