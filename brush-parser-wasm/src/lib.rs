use std::collections::HashMap;

use brush_parser::ast::{
    AndOr, AndOrList, ArithmeticCommand, Command, CommandPrefixOrSuffixItem, CompoundCommand,
    CompoundList, IoFileRedirectKind, IoFileRedirectTarget, IoRedirect, Pipeline, Program,
    SeparatorOperator, SimpleCommand, Word,
};
use brush_parser::word::{self, Parameter, ParameterExpr, WordPiece};
use brush_parser::{ParserOptions, SourceInfo};
use serde::Serialize;
use wasm_bindgen::prelude::*;

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum AstNode {
    Pipeline {
        commands: Vec<CommandNode>,
    },
    Logical {
        op: String,
        left: Box<AstNode>,
        right: Box<AstNode>,
    },
    Arithmetic {
        expression: String,
    },
    Sequence {
        nodes: Vec<AstNode>,
    },
}

#[derive(Serialize)]
struct CommandNode {
    #[serde(rename = "type")]
    node_type: &'static str,
    words: Vec<String>,
    redirections: Vec<RedirectionNode>,
}

#[derive(Serialize)]
struct RedirectionNode {
    op: String,
    target: String,
}

struct Lowerer {
    env: HashMap<String, String>,
    home: String,
}

#[wasm_bindgen]
pub fn parse_shell(source: &str, env: JsValue, home: &str) -> Result<JsValue, JsValue> {
    let env = serde_wasm_bindgen::from_value(env).unwrap_or_default();
    let reader = std::io::Cursor::new(source.as_bytes());
    let options = ParserOptions::default();
    let source_info = SourceInfo {
        source: "runtime input".to_owned(),
    };
    let mut parser = brush_parser::Parser::new(reader, &options, &source_info);
    let program = parser
        .parse_program()
        .map_err(|err| JsValue::from_str(&format_parse_error(&err.to_string())))?;
    let ast = Lowerer {
        env,
        home: home.to_owned(),
    }
    .program(&program)
    .map_err(|err| JsValue::from_str(&err))?;

    serde_wasm_bindgen::to_value(&ast).map_err(|err| JsValue::from_str(&err.to_string()))
}

impl Lowerer {
    fn program(&self, program: &Program) -> Result<Option<AstNode>, String> {
        let mut nodes = Vec::new();
        for command in &program.complete_commands {
            nodes.push(self.compound_list(command)?);
        }
        Ok(sequence(nodes))
    }

    fn compound_list(&self, list: &CompoundList) -> Result<AstNode, String> {
        let mut nodes = Vec::new();
        for item in &list.0 {
            if matches!(item.1, SeparatorOperator::Async) {
                return Err("unsupported async command separator".to_owned());
            }
            nodes.push(self.and_or_list(&item.0)?);
        }
        sequence(nodes).ok_or_else(|| "unsupported empty compound list".to_owned())
    }

    fn and_or_list(&self, list: &AndOrList) -> Result<AstNode, String> {
        let mut current = self.pipeline(&list.first)?;
        for item in &list.additional {
            let (op, pipeline) = match item {
                AndOr::And(pipeline) => ("&&", pipeline),
                AndOr::Or(pipeline) => ("||", pipeline),
            };
            current = AstNode::Logical {
                op: op.to_owned(),
                left: Box::new(current),
                right: Box::new(self.pipeline(pipeline)?),
            };
        }
        Ok(current)
    }

    fn pipeline(&self, pipeline: &Pipeline) -> Result<AstNode, String> {
        if pipeline.bang {
            return Err("unsupported negated pipeline".to_owned());
        }
        if pipeline.seq.len() == 1 {
            if let Command::Compound(CompoundCommand::Arithmetic(command), redirects) =
                &pipeline.seq[0]
            {
                if redirects.is_some() {
                    return Err("unsupported redirection on arithmetic command".to_owned());
                }
                return Ok(AstNode::Arithmetic {
                    expression: arithmetic_text(command),
                });
            }
        }
        let mut commands = Vec::new();
        for command in &pipeline.seq {
            commands.push(self.simple_command(command)?);
        }
        Ok(AstNode::Pipeline { commands })
    }

    fn simple_command(&self, command: &Command) -> Result<CommandNode, String> {
        match command {
            Command::Simple(command) => self.simple(command),
            Command::Compound(CompoundCommand::Arithmetic(command), _) => Err(format!(
                "unsupported arithmetic command in pipeline: {}",
                arithmetic_text(command)
            )),
            Command::Compound(_, _) => Err("unsupported compound command".to_owned()),
            Command::Function(_) => Err("unsupported function declaration".to_owned()),
            Command::ExtendedTest(_) => Err("unsupported [[ test ]] command".to_owned()),
        }
    }

    fn simple(&self, command: &SimpleCommand) -> Result<CommandNode, String> {
        let mut assignments = Vec::new();
        let mut words = Vec::new();
        let mut redirections = Vec::new();

        if let Some(prefix) = &command.prefix {
            for item in &prefix.0 {
                self.command_item(item, &mut assignments, &mut words, &mut redirections)?;
            }
        }
        if let Some(word) = &command.word_or_name {
            words.push(self.word(word)?);
        }
        if let Some(suffix) = &command.suffix {
            for item in &suffix.0 {
                self.command_item(item, &mut assignments, &mut words, &mut redirections)?;
            }
        }

        let words = if assignments.is_empty() {
            words
        } else if words.is_empty() {
            let mut export_words = vec!["export".to_owned()];
            export_words.extend(assignments);
            export_words
        } else {
            let mut env_words = vec!["env".to_owned()];
            env_words.extend(assignments);
            env_words.extend(words);
            env_words
        };

        if words.is_empty() && !redirections.is_empty() {
            return Err("unsupported redirection without command".to_owned());
        }

        Ok(CommandNode {
            node_type: "command",
            words,
            redirections,
        })
    }

    fn command_item(
        &self,
        item: &CommandPrefixOrSuffixItem,
        assignments: &mut Vec<String>,
        words: &mut Vec<String>,
        redirections: &mut Vec<RedirectionNode>,
    ) -> Result<(), String> {
        match item {
            CommandPrefixOrSuffixItem::AssignmentWord(_, word) => {
                assignments.push(self.word(word)?)
            }
            CommandPrefixOrSuffixItem::Word(word) => words.push(self.word(word)?),
            CommandPrefixOrSuffixItem::IoRedirect(redirect) => {
                redirections.push(self.redirection(redirect)?);
            }
            CommandPrefixOrSuffixItem::ProcessSubstitution(..) => {
                return Err("unsupported process substitution".to_owned());
            }
        }
        Ok(())
    }

    fn redirection(&self, redirect: &IoRedirect) -> Result<RedirectionNode, String> {
        match redirect {
            IoRedirect::File(_, kind, target) => {
                let op = match kind {
                    IoFileRedirectKind::Read => "<",
                    IoFileRedirectKind::Write | IoFileRedirectKind::Clobber => ">",
                    IoFileRedirectKind::Append => ">>",
                    IoFileRedirectKind::ReadAndWrite
                    | IoFileRedirectKind::DuplicateInput
                    | IoFileRedirectKind::DuplicateOutput => {
                        return Err("unsupported file descriptor redirection".to_owned());
                    }
                };
                let target = match target {
                    IoFileRedirectTarget::Filename(word) => self.word(word)?,
                    _ => return Err("unsupported redirection target".to_owned()),
                };
                Ok(RedirectionNode {
                    op: op.to_owned(),
                    target,
                })
            }
            IoRedirect::HereDocument { .. } => Err("unsupported here document".to_owned()),
            IoRedirect::HereString { .. } => Err("unsupported here string".to_owned()),
            IoRedirect::OutputAndError(target, append) => Ok(RedirectionNode {
                op: if *append { ">>" } else { ">" }.to_owned(),
                target: self.word(target)?,
            }),
        }
    }

    fn word(&self, word: &Word) -> Result<String, String> {
        let pieces = word::parse(&word.value, &ParserOptions::default())
            .map_err(|err| format!("unsupported shell word: {err}"))?;
        let mut out = String::new();
        for piece in pieces {
            out.push_str(&self.word_piece(&piece.piece)?);
        }
        Ok(out)
    }

    fn word_piece(&self, piece: &WordPiece) -> Result<String, String> {
        match piece {
            WordPiece::Text(text)
            | WordPiece::SingleQuotedText(text)
            | WordPiece::AnsiCQuotedText(text) => Ok(text.clone()),
            WordPiece::DoubleQuotedSequence(pieces)
            | WordPiece::GettextDoubleQuotedSequence(pieces) => {
                let mut out = String::new();
                for piece in pieces {
                    out.push_str(&self.word_piece(&piece.piece)?);
                }
                Ok(out)
            }
            WordPiece::TildePrefix(prefix) if prefix.is_empty() => Ok(self.home.clone()),
            WordPiece::TildePrefix(_) => Err("unsupported named tilde expansion".to_owned()),
            WordPiece::ParameterExpansion(expansion) => self.parameter(expansion),
            WordPiece::EscapeSequence(text) => Ok(text.clone()),
            WordPiece::CommandSubstitution(_)
            | WordPiece::BackquotedCommandSubstitution(_)
            | WordPiece::ArithmeticExpression(_) => Err("unsupported shell expansion".to_owned()),
        }
    }

    fn parameter(&self, expression: &ParameterExpr) -> Result<String, String> {
        match expression {
            ParameterExpr::Parameter { parameter, .. } => self.parameter_value(parameter),
            ParameterExpr::ParameterLength { parameter, .. } => {
                Ok(self.parameter_value(parameter)?.len().to_string())
            }
            ParameterExpr::UseDefaultValues {
                parameter,
                default_value,
                ..
            } => {
                let value = self.parameter_value(parameter)?;
                if value.is_empty() {
                    Ok(default_value.clone().unwrap_or_default())
                } else {
                    Ok(value)
                }
            }
            _ => Err("unsupported parameter expansion".to_owned()),
        }
    }

    fn parameter_value(&self, parameter: &Parameter) -> Result<String, String> {
        match parameter {
            Parameter::Named(name) => Ok(self.env.get(name).cloned().unwrap_or_default()),
            Parameter::Special(_) | Parameter::Positional(_) => Ok(String::new()),
            _ => Err("unsupported parameter expansion".to_owned()),
        }
    }
}

fn arithmetic_text(command: &ArithmeticCommand) -> String {
    command.expr.to_string()
}

fn format_parse_error(message: &str) -> String {
    if message.contains("unterminated")
        || message.contains("end of file")
        || message.contains("EOF")
    {
        "syntax error: unexpected EOF while parsing shell input".to_owned()
    } else {
        format!("syntax error: {message}")
    }
}

fn sequence(nodes: Vec<AstNode>) -> Option<AstNode> {
    match nodes.len() {
        0 => None,
        1 => nodes.into_iter().next(),
        _ => Some(AstNode::Sequence { nodes }),
    }
}
