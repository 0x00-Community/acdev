use std::collections::{HashMap, HashSet};

use naga::{Block, Expression, Function, Handle, Module, SampleLevel, Statement};

#[derive(Default)]
pub struct Live {
    pub globals: HashSet<Handle<naga::GlobalVariable>>,
    pub members: HashMap<Handle<naga::GlobalVariable>, HashSet<u32>>,
    pub dynamic: HashSet<Handle<naga::GlobalVariable>>,
}

impl Live {
    pub fn of(module: &Module) -> Self {
        let mut live = Live::default();
        let Some(entry) = module.entry_points.first() else { return live };
        let mut functions = Vec::new();
        calls(&entry.function.body, &mut functions);
        let mut seen = HashSet::new();
        while let Some(handle) = functions.pop() {
            if !seen.insert(handle) {
                continue;
            }
            let function = &module.functions[handle];
            calls(&function.body, &mut functions);
            live.function(function);
        }
        live
    }

    fn function(&mut self, function: &Function) {
        let mut roots = Vec::new();
        statements(&function.body, &mut roots);
        let mut seen = HashSet::new();
        while let Some(expr) = roots.pop() {
            if !seen.insert(expr) {
                continue;
            }
            let e = &function.expressions[expr];
            match *e {
                Expression::GlobalVariable(g) => {
                    self.globals.insert(g);
                }
                Expression::AccessIndex { base, index } => {
                    if let Expression::GlobalVariable(g) = function.expressions[base] {
                        self.members.entry(g).or_default().insert(index);
                    }
                }
                Expression::Access { base, index } => {
                    if let Expression::GlobalVariable(g) = function.expressions[base] {
                        match function.expressions[index] {
                            Expression::Literal(naga::Literal::I32(i)) if i >= 0 => {
                                self.members.entry(g).or_default().insert(i as u32);
                            }
                            Expression::Literal(naga::Literal::U32(i)) => {
                                self.members.entry(g).or_default().insert(i);
                            }
                            _ => {
                                self.dynamic.insert(g);
                            }
                        }
                    }
                }
                _ => {}
            }
            operands(e, &mut roots);
        }
    }

    pub fn member(&self, global: Handle<naga::GlobalVariable>, index: u32) -> bool {
        self.dynamic.contains(&global) || self.members.get(&global).is_some_and(|m| m.contains(&index))
    }
}

fn calls(block: &Block, out: &mut Vec<Handle<Function>>) {
    for statement in block.iter() {
        match *statement {
            Statement::Call { function, .. } => out.push(function),
            Statement::Block(ref b) => calls(b, out),
            Statement::If { ref accept, ref reject, .. } => {
                calls(accept, out);
                calls(reject, out);
            }
            Statement::Switch { ref cases, .. } => cases.iter().for_each(|c| calls(&c.body, out)),
            Statement::Loop { ref body, ref continuing, .. } => {
                calls(body, out);
                calls(continuing, out);
            }
            _ => {}
        }
    }
}

fn statements(block: &Block, out: &mut Vec<Handle<Expression>>) {
    for statement in block.iter() {
        match *statement {
            Statement::Block(ref b) => statements(b, out),
            Statement::If { condition, ref accept, ref reject } => {
                out.push(condition);
                statements(accept, out);
                statements(reject, out);
            }
            Statement::Switch { selector, ref cases } => {
                out.push(selector);
                cases.iter().for_each(|c| statements(&c.body, out));
            }
            Statement::Loop { ref body, ref continuing, break_if } => {
                statements(body, out);
                statements(continuing, out);
                out.extend(break_if);
            }
            Statement::Return { value } => out.extend(value),
            Statement::Store { pointer, value } => out.extend([pointer, value]),
            Statement::ImageStore { image, coordinate, array_index, value } => {
                out.extend([image, coordinate, value]);
                out.extend(array_index);
            }
            Statement::Call { ref arguments, .. } => out.extend(arguments.iter().copied()),
            Statement::Atomic { pointer, value, .. } => out.extend([pointer, value]),
            _ => {}
        }
    }
}

fn operands(e: &Expression, out: &mut Vec<Handle<Expression>>) {
    match *e {
        Expression::Compose { ref components, .. } => out.extend(components.iter().copied()),
        Expression::Access { base, index } => out.extend([base, index]),
        Expression::AccessIndex { base, .. } => out.push(base),
        Expression::Splat { value, .. } => out.push(value),
        Expression::Swizzle { vector, .. } => out.push(vector),
        Expression::Load { pointer } => out.push(pointer),
        Expression::ImageSample { image, sampler, coordinate, array_index, offset, level, depth_ref, .. } => {
            out.extend([image, sampler, coordinate]);
            out.extend(array_index);
            out.extend(offset);
            out.extend(depth_ref);
            match level {
                SampleLevel::Exact(h) | SampleLevel::Bias(h) => out.push(h),
                SampleLevel::Gradient { x, y } => out.extend([x, y]),
                SampleLevel::Auto | SampleLevel::Zero => {}
            }
        }
        Expression::ImageLoad { image, coordinate, array_index, sample, level } => {
            out.extend([image, coordinate]);
            out.extend(array_index);
            out.extend(sample);
            out.extend(level);
        }
        Expression::ImageQuery { image, query } => {
            out.push(image);
            if let naga::ImageQuery::Size { level: Some(level) } = query {
                out.push(level);
            }
        }
        Expression::Unary { expr, .. } | Expression::Derivative { expr, .. } | Expression::As { expr, .. } => out.push(expr),
        Expression::Binary { left, right, .. } => out.extend([left, right]),
        Expression::Select { condition, accept, reject } => out.extend([condition, accept, reject]),
        Expression::Relational { argument, .. } => out.push(argument),
        Expression::Math { arg, arg1, arg2, arg3, .. } => {
            out.push(arg);
            out.extend(arg1);
            out.extend(arg2);
            out.extend(arg3);
        }
        Expression::ArrayLength(h) => out.push(h),
        _ => {}
    }
}
